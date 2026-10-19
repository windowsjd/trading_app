import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { importantNoticeCopy, PUSH_TTL_MS } from './push-copy';
import {
  type Keyset,
  type PushCandidate,
  type ScanArgs,
  type ScanWindow,
  type SourcePage,
  readConditionalBuyFailures,
  readConditionalSellFailures,
  readEntryPlanFailures,
  readFriendRequests,
  readFuturesConditionalEntryFailures,
  readFuturesFills,
  readFuturesTpSlFailures,
  readLiquidations,
  readLocFailures,
  readSeasonFinalResults,
  readSpotFills,
  scanSeasonEndingSoon,
} from './push-sources';
import { noticeSourceKey } from './important-notices.service';
import type { PushNotificationsConfig } from './push-notifications.config';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Reader = (db: PrismaService, args: ScanArgs) => Promise<SourcePage>;

/** Windowed sources and how far back a scan may catch up after the worker
 * was stopped. Older events are not announced (they would be stale). */
export const WINDOWED_SOURCES: ReadonlyArray<{
  source: string;
  catchUpMs: number;
  read: Reader;
}> = [
  { source: 'spot_fills', catchUpMs: 30 * MINUTE, read: readSpotFills },
  { source: 'futures_fills', catchUpMs: 30 * MINUTE, read: readFuturesFills },
  {
    source: 'futures_liquidations',
    catchUpMs: 2 * HOUR,
    read: readLiquidations,
  },
  { source: 'failures_loc', catchUpMs: 2 * HOUR, read: readLocFailures },
  {
    source: 'failures_conditional_buy',
    catchUpMs: 2 * HOUR,
    read: readConditionalBuyFailures,
  },
  {
    source: 'failures_conditional_sell',
    catchUpMs: 2 * HOUR,
    read: readConditionalSellFailures,
  },
  {
    source: 'failures_futures_conditional_entry',
    catchUpMs: 2 * HOUR,
    read: readFuturesConditionalEntryFailures,
  },
  {
    source: 'failures_futures_tp_sl',
    catchUpMs: 2 * HOUR,
    read: readFuturesTpSlFailures,
  },
  {
    source: 'failures_entry_tp_sl_plan',
    catchUpMs: 2 * HOUR,
    read: readEntryPlanFailures,
  },
  { source: 'friend_requests', catchUpMs: 6 * HOUR, read: readFriendRequests },
  {
    source: 'season_final_results',
    catchUpMs: 24 * HOUR,
    read: readSeasonFinalResults,
  },
];

/** Pages read per source in one tick; a source with more waiting resumes
 * exactly after the last row next tick. */
export const PAGES_PER_SOURCE = 10;

/** A Season's participant list is swept for "ending soon" at most this often,
 * so a late joiner inside the 24 h window is still reached. */
export const SEASON_ENDING_SWEEP_MS = 10 * MINUTE;
const NOTICES_PER_TICK = 5;
const FANOUT_PAGES_PER_TICK = 4;
const INSERT_CHUNK = 500;

export type ScanSummary = {
  created: Record<string, number>;
  failedSources: string[];
};

type Cursor = { startedAt: Date; scannedTo: Date; resumeId: string | null };

/** Where a source reads next. After a drained scan: from its high-water mark
 * minus the lookback (late commits), never before its first scan nor further
 * back than its catch-up horizon. After a scan that stopped on a full page:
 * exactly after the last row read, unless that is past the horizon.
 * Exported for tests. */
export function scanPlan(
  cursor: Cursor,
  now: Date,
  lookbackMs: number,
  catchUpMs: number,
): { window: ScanWindow; after: Keyset | null } {
  const horizon = now.getTime() - catchUpMs;
  if (cursor.resumeId && cursor.scannedTo.getTime() >= horizon)
    return {
      window: { from: cursor.scannedTo, to: now },
      after: { at: cursor.scannedTo, id: cursor.resumeId },
    };
  return {
    window: {
      from: new Date(
        Math.max(
          cursor.scannedTo.getTime() - lookbackMs,
          horizon,
          cursor.startedAt.getTime(),
        ),
      ),
      to: now,
    },
    after: null,
  };
}

/** Turns committed source rows into outbox rows. Every insert is
 * `ON CONFLICT DO NOTHING` on (user, type, source key): rescans, restarts and
 * overlapping workers cannot create a second notification for one event. */
@Injectable()
export class PushNotificationScanner {
  constructor(private readonly prisma: PrismaService) {}

  async scan(now: Date, config: PushNotificationsConfig): Promise<ScanSummary> {
    const summary: ScanSummary = { created: {}, failedSources: [] };
    for (const { source, catchUpMs, read } of WINDOWED_SOURCES) {
      try {
        const cursor = await this.prisma.pushScanCursor.findUnique({
          where: { source },
        });
        if (!cursor) {
          // First scan: this source starts now; nothing earlier is sent.
          await this.prisma.pushScanCursor.createMany({
            data: [{ source, startedAt: now, scannedTo: now }],
            skipDuplicates: true,
          });
          continue;
        }
        const plan = scanPlan(cursor, now, config.scanLookbackMs, catchUpMs);
        let after = plan.after;
        // Resume point if the budget runs out: the newest row old enough to
        // be committed, so a younger row that commits late is read again.
        let resume = plan.after;
        let created = 0;
        let drained = false;
        for (let pageIndex = 0; pageIndex < PAGES_PER_SOURCE; pageIndex++) {
          const page = await read(this.prisma, {
            window: plan.window,
            after,
            now,
          });
          created += await this.insert(page.candidates, now);
          if (!page.full || !page.last) {
            drained = true;
            break;
          }
          after = page.last;
          if (page.lastSafe) resume = page.lastSafe;
        }
        // Only when every row read is that young (a burst inside the last
        // 30 s) does the scan resume after the last row instead.
        resume = resume ?? after;
        summary.created[source] = created;
        await this.prisma.pushScanCursor.update({
          where: { source },
          data:
            drained || !resume
              ? { scannedTo: plan.window.to, resumeId: null }
              : { scannedTo: resume.at, resumeId: resume.id },
        });
      } catch {
        summary.failedSources.push(source);
      }
    }
    try {
      summary.created.season_ending_soon = await this.seasonEndingSoon(now);
    } catch {
      summary.failedSources.push('season_ending_soon');
    }
    try {
      summary.created.important_notice = await this.noticeFanout(now, config);
    } catch {
      summary.failedSources.push('important_notice');
    }
    return summary;
  }

  private async seasonEndingSoon(now: Date): Promise<number> {
    let created = 0;
    for (const group of await scanSeasonEndingSoon(this.prisma, now)) {
      const source = `season_ending:${group.seasonId}`;
      const cursor = await this.prisma.pushScanCursor.findUnique({
        where: { source },
      });
      if (
        cursor &&
        now.getTime() - cursor.scannedTo.getTime() < SEASON_ENDING_SWEEP_MS
      )
        continue;
      created += await this.insert(group.candidates, now);
      // Insert-or-ignore then update: safe if two workers ever overlap.
      await this.prisma.pushScanCursor.createMany({
        data: [{ source, startedAt: now, scannedTo: now }],
        skipDuplicates: true,
      });
      await this.prisma.pushScanCursor.update({
        where: { source },
        data: { scannedTo: now },
      });
    }
    return created;
  }

  /** Fan-out of a published important notice to active users that have a
   * registered device and the type on, in ascending user-id pages. A notice
   * older than its TTL is closed without further sends. */
  private async noticeFanout(
    now: Date,
    config: PushNotificationsConfig,
  ): Promise<number> {
    let created = 0;
    const notices = await this.prisma.importantNotice.findMany({
      where: { status: 'published', fanoutCompletedAt: null },
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
      take: NOTICES_PER_TICK,
    });
    for (const notice of notices) {
      if (!notice.publishedAt) continue;
      const expiresAt = new Date(
        notice.publishedAt.getTime() + PUSH_TTL_MS.important_notice,
      );
      if (now >= expiresAt) {
        await this.prisma.importantNotice.updateMany({
          where: {
            id: notice.id,
            status: 'published',
            fanoutCompletedAt: null,
          },
          data: { fanoutCompletedAt: now },
        });
        continue;
      }
      let cursor = notice.fanoutCursor ?? '';
      const copy = importantNoticeCopy(notice);
      for (let page = 0; page < FANOUT_PAGES_PER_TICK; page++) {
        const users = await this.prisma.user.findMany({
          where: {
            id: { gt: cursor },
            status: 'active',
            pushDevices: { some: {} },
            OR: [
              { notificationPreference: { is: null } },
              {
                notificationPreference: {
                  is: { importantNotice: true, allEnabled: true },
                },
              },
            ],
          },
          orderBy: { id: 'asc' },
          take: config.fanoutPageSize,
          select: { id: true },
        });
        created += await this.insert(
          users.map(
            (user): PushCandidate => ({
              userId: user.id,
              type: 'important_notice',
              sourceKey: noticeSourceKey(notice.id),
              tradingAccountId: null,
              copy,
              data: {
                v: 1,
                type: 'important_notice',
                uid: user.id,
                noticeId: notice.id,
              },
              eventAt: notice.publishedAt!,
              expiresAt,
            }),
          ),
          now,
        );
        if (users.length) cursor = users[users.length - 1].id;
        const done = users.length < config.fanoutPageSize;
        // A withdrawn notice keeps its state; the fan-out just stops.
        await this.prisma.importantNotice.updateMany({
          where: { id: notice.id, status: 'published' },
          data: {
            fanoutCursor: cursor || null,
            ...(done ? { fanoutCompletedAt: now } : {}),
          },
        });
        if (done) break;
      }
    }
    return created;
  }

  async insert(
    candidates: readonly PushCandidate[],
    now: Date,
  ): Promise<number> {
    let created = 0;
    for (let index = 0; index < candidates.length; index += INSERT_CHUNK) {
      const chunk = candidates.slice(index, index + INSERT_CHUNK);
      const result = await this.prisma.pushNotification.createMany({
        data: chunk.map(
          (candidate): Prisma.PushNotificationCreateManyInput => ({
            userId: candidate.userId,
            type: candidate.type,
            sourceKey: candidate.sourceKey,
            tradingAccountId: candidate.tradingAccountId,
            title: candidate.copy.title,
            body: candidate.copy.body,
            data: candidate.data as Prisma.InputJsonValue,
            eventAt: candidate.eventAt,
            expiresAt: candidate.expiresAt,
            nextAttemptAt: now,
          }),
        ),
        skipDuplicates: true,
      });
      created += result.count;
    }
    return created;
  }
}
