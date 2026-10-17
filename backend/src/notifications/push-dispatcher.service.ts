import { Injectable } from '@nestjs/common';
import type { Prisma, PushNotificationType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ExpoPushClient,
  type ExpoPushMessage,
  type ExpoSendResult,
  RETRYABLE_EXPO_ERRORS,
} from './expo-push.client';
import { pushPriority } from './push-copy';
import { preferenceEnabled } from './notification-preferences.service';
import { parseSeasonEndingSourceKey } from './push-sources';
import type { PushNotificationsConfig } from './push-notifications.config';

/** Android channel the app creates before asking for permission. */
export const PUSH_CHANNEL_ID = 'default';

export type ClaimedNotification = {
  id: string;
  userId: string;
  type: PushNotificationType;
  sourceKey: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  expiresAt: Date;
  attemptCount: number;
};

export type DispatchSummary = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: Record<string, number>;
  tickets: { ok: number; error: number };
  devicesRemoved: number;
};

export type SkipReason =
  | 'expired'
  | 'source_invalid'
  | 'user_inactive'
  | 'preference_disabled'
  | 'no_device'
  | 'dry_run';

type Outcome =
  | { kind: 'sent' }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'retry'; code: string; nextAttemptAt: Date }
  | { kind: 'failed'; code: string };

type SendResult = { ok: boolean; code?: string; retryable?: boolean };
type DeviceRow = {
  id: string;
  userId: string;
  token: string;
  registeredAt: Date;
};
type OutgoingItem = { device: DeviceRow; message: ExpoPushMessage };
type OutgoingGroup = {
  notification: ClaimedNotification;
  items: OutgoingItem[];
};

/** Requests of at most `size` messages that keep one notification's
 * devices together (a user has at most 10), so a deadline between requests
 * leaves a notification either fully sent or not sent. Only a notification
 * with more devices than one request holds is spread over several.
 * Exported for tests. */
export function packGroups<T extends { items: readonly unknown[] }>(
  groups: readonly T[],
  size: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let count = 0;
  const close = () => {
    if (current.length) chunks.push(current);
    current = [];
    count = 0;
  };
  for (const group of groups) {
    if (group.items.length > size) {
      close();
      for (let index = 0; index < group.items.length; index += size)
        chunks.push([
          { ...group, items: group.items.slice(index, index + size) },
        ]);
      continue;
    }
    if (count + group.items.length > size) close();
    current.push(group);
    count += group.items.length;
  }
  close();
  return chunks;
}

/** Final outcome of one claimed notification from its device results.
 * Exported for tests. */
export function decideOutcome(
  notification: Pick<ClaimedNotification, 'attemptCount' | 'expiresAt'>,
  results: ReadonlyArray<SendResult>,
  now: Date,
  config: Pick<PushNotificationsConfig, 'maxAttempts' | 'retryDelaysMs'>,
): Outcome {
  if (results.some((result) => result.ok)) return { kind: 'sent' };
  const retryable = results.find((result) => result.retryable);
  const code = (retryable ?? results[0])?.code ?? 'PUSH_SEND_FAILED';
  if (retryable && notification.attemptCount < config.maxAttempts) {
    const delays = config.retryDelaysMs;
    const delay =
      delays[Math.min(notification.attemptCount - 1, delays.length - 1)] ?? 0;
    const nextAttemptAt = new Date(now.getTime() + Math.max(delay, 0));
    if (nextAttemptAt < notification.expiresAt)
      return { kind: 'retry', code, nextAttemptAt };
  }
  return { kind: 'failed', code };
}

@Injectable()
export class PushDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expo: ExpoPushClient,
  ) {}

  /** Claims due rows under a lease, trading outcomes and social/Season rows
   * first and important-notice fan-out rows with the remaining capacity, so a
   * large notice never delays a fill or a liquidation. SKIP LOCKED + the
   * status/lease condition keep two workers off the same row; a crashed send
   * is reclaimed after the lease (at-least-once, as Expo itself is). */
  async claim(now: Date, config: PushNotificationsConfig) {
    const first = await this.claimRows(
      now,
      config,
      config.dispatchBatchSize,
      false,
    );
    const room = config.dispatchBatchSize - first.length;
    const notices =
      room > 0 ? await this.claimRows(now, config, room, true) : [];
    return [...first, ...notices];
  }

  private async claimRows(
    now: Date,
    config: PushNotificationsConfig,
    limit: number,
    notices: boolean,
  ) {
    const leaseUntil = new Date(now.getTime() + config.claimLeaseMs);
    const rows = await this.prisma.$queryRaw<
      Array<Omit<ClaimedNotification, 'data'> & { data: unknown }>
    >`
      UPDATE "push_notifications" AS n
      SET "status" = 'sending',
          "claimed_until" = ${leaseUntil},
          "attempt_count" = n."attempt_count" + 1,
          "updated_at" = ${now}
      WHERE n."id" IN (
        SELECT "id" FROM "push_notifications"
        WHERE (("status" = 'pending' AND "next_attempt_at" <= ${now})
            OR ("status" = 'sending' AND "claimed_until" < ${now}))
          AND ("type" = 'important_notice') = ${notices}
        ORDER BY "next_attempt_at", "id"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING n."id", n."user_id" AS "userId", n."type"::text AS "type",
        n."source_key" AS "sourceKey", n."title", n."body", n."data",
        n."expires_at" AS "expiresAt", n."attempt_count" AS "attemptCount"`;
    return rows.map(
      (row): ClaimedNotification => ({
        ...row,
        data:
          row.data && typeof row.data === 'object'
            ? (row.data as Record<string, unknown>)
            : {},
      }),
    );
  }

  async dispatch(
    now: Date,
    config: PushNotificationsConfig,
  ): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      skipped: {},
      tickets: { ok: 0, error: 0 },
      devicesRemoved: 0,
    };
    const claimed = await this.claim(now, config);
    summary.claimed = claimed.length;
    if (!claimed.length) return summary;

    const userIds = [...new Set(claimed.map((row) => row.userId))];
    const [users, preferences, devices, invalid] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, status: true },
      }),
      this.prisma.notificationPreference.findMany({
        where: { userId: { in: userIds } },
      }),
      this.prisma.pushDevice.findMany({
        where: { userId: { in: userIds } },
        orderBy: { registeredAt: 'desc' },
        select: { id: true, userId: true, token: true, registeredAt: true },
      }),
      this.invalidSources(claimed, now),
    ]);
    const activeUsers = new Set(
      users.filter((user) => user.status === 'active').map((user) => user.id),
    );
    const preferenceByUser = new Map(
      preferences.map((row) => [row.userId, row]),
    );
    const devicesByUser = new Map<string, DeviceRow[]>();
    for (const device of devices)
      devicesByUser.set(device.userId, [
        ...(devicesByUser.get(device.userId) ?? []),
        device,
      ]);

    const outcomes = new Map<string, Outcome>();
    const groups: OutgoingGroup[] = [];
    for (const notification of claimed) {
      const userDevices = devicesByUser.get(notification.userId) ?? [];
      const skip: SkipReason | null =
        now >= notification.expiresAt
          ? 'expired'
          : invalid.has(notification.id)
            ? 'source_invalid'
            : !activeUsers.has(notification.userId)
              ? 'user_inactive'
              : !preferenceEnabled(
                    preferenceByUser.get(notification.userId),
                    notification.type,
                  )
                ? 'preference_disabled'
                : !userDevices.length
                  ? 'no_device'
                  : config.dryRun
                    ? 'dry_run'
                    : null;
      if (skip) {
        outcomes.set(notification.id, { kind: 'skipped', reason: skip });
        continue;
      }
      const ttl = Math.max(
        1,
        Math.floor((notification.expiresAt.getTime() - now.getTime()) / 1000),
      );
      groups.push({
        notification,
        items: userDevices.map((device) => ({
          device,
          message: {
            to: device.token,
            title: notification.title,
            body: notification.body,
            data: notification.data,
            sound: 'default',
            priority: pushPriority(notification.type),
            channelId: PUSH_CHANNEL_ID,
            ttl,
          },
        })),
      });
    }

    const results = new Map<string, SendResult[]>();
    const deliveries: Prisma.PushDeliveryCreateManyInput[] = [];
    const deadDevices: Array<{ id: string; registeredAt: Date }> = [];
    const endpoint = {
      url: config.sendUrl,
      accessToken: config.accessToken,
      timeoutMs: config.requestTimeoutMs,
    };
    const record = (
      entry: { group: OutgoingGroup; item: OutgoingItem },
      response: ExpoSendResult,
      position: number,
    ) => {
      const list = results.get(entry.group.notification.id)!;
      if (response.kind === 'failed') {
        list.push({
          ok: false,
          code: response.code,
          retryable: response.retryable,
        });
        return;
      }
      const ticket = response.tickets[position];
      const base = {
        notificationId: entry.group.notification.id,
        deviceId: entry.item.device.id,
      };
      if (ticket.ok) {
        summary.tickets.ok++;
        list.push({ ok: true });
        deliveries.push({ ...base, ticketId: ticket.id, status: 'ticket_ok' });
        return;
      }
      summary.tickets.error++;
      list.push({
        ok: false,
        code: ticket.error,
        retryable: RETRYABLE_EXPO_ERRORS.has(ticket.error),
      });
      deliveries.push({
        ...base,
        status: 'ticket_error',
        errorCode: ticket.error,
      });
      if (ticket.error === 'DeviceNotRegistered')
        deadDevices.push({
          id: entry.item.device.id,
          registeredAt: entry.item.device.registeredAt,
        });
    };
    // Sending stops well inside the claim lease, so another worker can never
    // reclaim (and resend) a row this one is still sending.
    const sendDeadline = Date.now() + config.claimLeaseMs / 2;
    for (const chunk of packGroups(groups, config.sendChunkSize)) {
      if (Date.now() >= sendDeadline) break;
      // Ownership right before the request: a device released or taken over
      // by another sign-in since the claim no longer gets this user's push.
      const current = new Map(
        (
          await this.prisma.pushDevice.findMany({
            where: {
              id: {
                in: chunk.flatMap((group) =>
                  group.items.map((item) => item.device.id),
                ),
              },
            },
            select: { id: true, userId: true, token: true },
          })
        ).map((device) => [device.id, device]),
      );
      const live: Array<{ group: OutgoingGroup; item: OutgoingItem }> = [];
      for (const group of chunk) {
        if (!results.has(group.notification.id))
          results.set(group.notification.id, []);
        for (const item of group.items) {
          const device = current.get(item.device.id);
          if (
            device?.userId === group.notification.userId &&
            device.token === item.device.token
          )
            live.push({ group, item });
        }
      }
      if (!live.length) continue;
      const response = await this.expo.send(
        endpoint,
        live.map((entry) => entry.item.message),
      );
      if (
        response.kind === 'failed' &&
        !response.retryable &&
        live.length > 1
      ) {
        // One message (e.g. a token of another Expo project) can make Expo
        // reject the whole request: send each alone so only it fails.
        for (const entry of live)
          record(
            entry,
            Date.now() < sendDeadline
              ? await this.expo.send(endpoint, [entry.item.message])
              : { kind: 'failed', retryable: true, code: 'PUSH_SEND_DEFERRED' },
            0,
          );
      } else
        live.forEach((entry, position) => record(entry, response, position));
    }
    for (const { notification } of groups) {
      const list = results.get(notification.id);
      outcomes.set(
        notification.id,
        !list
          ? // Not reached before the deadline: straight back to the queue.
            { kind: 'retry', code: 'PUSH_SEND_DEFERRED', nextAttemptAt: now }
          : list.length
            ? decideOutcome(notification, list, now, config)
            : // Every device was released or taken over since the claim.
              { kind: 'skipped', reason: 'no_device' },
      );
    }

    // The outcome is written first: nothing after it (a device released
    // meanwhile, a failed delivery insert) can leave rows to be resent.
    await this.finalize(outcomes, now, summary);
    await this.recordDeliveries(deliveries);
    summary.devicesRemoved = await this.removeDeadDevices(deadDevices).catch(
      () => 0,
    );
    return summary;
  }

  /** Tickets for receipts and audit. A device released after the send keeps
   * its ticket without the device link; a failure here never undoes a send. */
  private async recordDeliveries(
    deliveries: Prisma.PushDeliveryCreateManyInput[],
  ) {
    if (!deliveries.length) return;
    try {
      const ids = [
        ...new Set(
          deliveries.flatMap((delivery) =>
            delivery.deviceId ? [delivery.deviceId] : [],
          ),
        ),
      ];
      const existing = new Set(
        (
          await this.prisma.pushDevice.findMany({
            where: { id: { in: ids } },
            select: { id: true },
          })
        ).map((device) => device.id),
      );
      const rows = deliveries.map((delivery) =>
        delivery.deviceId && !existing.has(delivery.deviceId)
          ? { ...delivery, deviceId: null }
          : delivery,
      );
      try {
        await this.prisma.pushDelivery.createMany({ data: rows });
      } catch {
        await this.prisma.pushDelivery.createMany({
          data: rows.map((delivery) => ({ ...delivery, deviceId: null })),
        });
      }
    } catch {
      // Receipts for this batch are lost; the sends themselves stand.
    }
  }

  /** Source re-checks right before a send: a request no longer pending, a
   * Season whose end moved or passed, a withdrawn notice, or a final result
   * an operator cleared is not announced. Trading outcomes are immutable. */
  private async invalidSources(
    claimed: readonly ClaimedNotification[],
    now: Date,
  ): Promise<Set<string>> {
    const invalid = new Set<string>();
    const ofType = (type: PushNotificationType) =>
      claimed.filter((row) => row.type === type);

    const friendRows = ofType('friend_request');
    if (friendRows.length) {
      const parsed = friendRows.map((row) => {
        const [, requesterId, friendshipId] = row.sourceKey.split(':');
        return { row, requesterId, friendshipId };
      });
      const friendships = await this.prisma.friendship.findMany({
        where: {
          id: { in: parsed.map((item) => item.friendshipId).filter(Boolean) },
          status: 'pending',
          lowUser: { status: 'active' },
          highUser: { status: 'active' },
        },
        select: { id: true, requesterUserId: true },
      });
      const pending = new Map(
        friendships.map((row) => [row.id, row.requesterUserId]),
      );
      for (const item of parsed)
        if (pending.get(item.friendshipId) !== item.requesterId)
          invalid.add(item.row.id);
    }

    const endingRows = ofType('season_ending_soon');
    if (endingRows.length) {
      const parsed = endingRows.map((row) => ({
        row,
        key: parseSeasonEndingSourceKey(row.sourceKey),
      }));
      const seasonIds = [
        ...new Set(
          parsed.flatMap((item) => (item.key ? [item.key.seasonId] : [])),
        ),
      ];
      const [seasons, participants] = await Promise.all([
        this.prisma.season.findMany({
          where: { id: { in: seasonIds } },
          select: { id: true, status: true, endAt: true },
        }),
        this.prisma.seasonParticipant.findMany({
          where: {
            seasonId: { in: seasonIds },
            userId: { in: endingRows.map((row) => row.userId) },
            participantStatus: 'active',
          },
          select: { seasonId: true, userId: true },
        }),
      ]);
      const seasonById = new Map(seasons.map((season) => [season.id, season]));
      const active = new Set(
        participants.map((item) => `${item.seasonId}|${item.userId}`),
      );
      for (const { row, key } of parsed) {
        const season = key ? seasonById.get(key.seasonId) : undefined;
        if (
          !key ||
          !season ||
          season.status !== 'active' ||
          season.endAt.getTime() !== key.endAtMs ||
          now >= season.endAt ||
          !active.has(`${key.seasonId}|${row.userId}`)
        )
          invalid.add(row.id);
      }
    }

    const noticeRows = ofType('important_notice');
    if (noticeRows.length) {
      const ids = noticeRows.map((row) =>
        row.sourceKey.replace(/^notice:/, ''),
      );
      const published = new Set(
        (
          await this.prisma.importantNotice.findMany({
            where: { id: { in: ids }, status: 'published' },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      for (const row of noticeRows)
        if (!published.has(row.sourceKey.replace(/^notice:/, '')))
          invalid.add(row.id);
    }

    const finalRows = ofType('season_final_result');
    if (finalRows.length) {
      const seasonIds = finalRows.map((row) =>
        row.sourceKey.replace(/^season_final:/, ''),
      );
      const confirmed = await this.prisma.seasonParticipant.findMany({
        where: {
          seasonId: { in: seasonIds },
          userId: { in: finalRows.map((row) => row.userId) },
          season: { status: 'settled' },
          finalRank: { not: null },
          finalTier: { not: null },
          participantStatus: { not: 'excluded' },
          rankingHiddenAt: null,
        },
        select: { seasonId: true, userId: true },
      });
      const ok = new Set(
        confirmed.map((item) => `${item.seasonId}|${item.userId}`),
      );
      for (const row of finalRows)
        if (
          !ok.has(
            `${row.sourceKey.replace(/^season_final:/, '')}|${row.userId}`,
          )
        )
          invalid.add(row.id);
    }
    return invalid;
  }

  /** A token Expo reports as not registered stops receiving, unless the
   * device registered again after that send. */
  private async removeDeadDevices(
    devices: ReadonlyArray<{ id: string; registeredAt: Date }>,
  ): Promise<number> {
    let removed = 0;
    for (const device of devices)
      removed += (
        await this.prisma.pushDevice.deleteMany({
          where: { id: device.id, registeredAt: { lte: device.registeredAt } },
        })
      ).count;
    return removed;
  }

  private async finalize(
    outcomes: Map<string, Outcome>,
    now: Date,
    summary: DispatchSummary,
  ) {
    const groups = new Map<
      string,
      { ids: string[]; data: Prisma.PushNotificationUpdateManyMutationInput }
    >();
    const add = (
      key: string,
      id: string,
      data: Prisma.PushNotificationUpdateManyMutationInput,
    ) => {
      const group = groups.get(key) ?? { ids: [], data };
      group.ids.push(id);
      groups.set(key, group);
    };
    for (const [id, outcome] of outcomes) {
      switch (outcome.kind) {
        case 'sent':
          summary.sent++;
          add('sent', id, {
            status: 'sent',
            sentAt: now,
            claimedUntil: null,
            lastErrorCode: null,
          });
          break;
        case 'skipped':
          summary.skipped[outcome.reason] =
            (summary.skipped[outcome.reason] ?? 0) + 1;
          add(`skipped:${outcome.reason}`, id, {
            status: 'skipped',
            skipReason: outcome.reason,
            claimedUntil: null,
          });
          break;
        case 'retry':
          summary.retried++;
          add(`retry:${outcome.code}:${outcome.nextAttemptAt.getTime()}`, id, {
            status: 'pending',
            nextAttemptAt: outcome.nextAttemptAt,
            lastErrorCode: outcome.code,
            claimedUntil: null,
          });
          break;
        case 'failed':
          summary.failed++;
          add(`failed:${outcome.code}`, id, {
            status: 'failed',
            lastErrorCode: outcome.code,
            claimedUntil: null,
          });
          break;
      }
    }
    for (const { ids, data } of groups.values())
      await this.prisma.pushNotification.updateMany({
        where: { id: { in: ids }, status: 'sending' },
        data,
      });
  }

  /** Resolves accepted tickets with Expo push receipts (available ~15 min
   * after sending, kept 24 h). DeviceNotRegistered removes the device. */
  async checkReceipts(now: Date, config: PushNotificationsConfig) {
    const result = {
      checked: 0,
      ok: 0,
      error: 0,
      missing: 0,
      devicesRemoved: 0,
      failure: null as string | null,
    };
    result.missing = (
      await this.prisma.pushDelivery.updateMany({
        where: {
          status: 'ticket_ok',
          createdAt: { lt: new Date(now.getTime() - config.receiptMaxAgeMs) },
        },
        data: { status: 'receipt_missing', receiptCheckedAt: now },
      })
    ).count;
    const due = await this.prisma.pushDelivery.findMany({
      where: {
        status: 'ticket_ok',
        createdAt: { lte: new Date(now.getTime() - config.receiptDelayMs) },
        OR: [
          { receiptCheckedAt: null },
          { receiptCheckedAt: { lte: new Date(now.getTime() - 10 * 60_000) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: config.receiptChunkSize,
      select: { id: true, ticketId: true, deviceId: true, createdAt: true },
    });
    if (!due.length) return result;
    const response = await this.expo.getReceipts(
      {
        url: config.receiptsUrl,
        accessToken: config.accessToken,
        timeoutMs: config.requestTimeoutMs,
      },
      due.map((delivery) => delivery.ticketId!),
    );
    if (response.kind === 'failed') {
      result.failure = response.code;
      return result;
    }
    result.checked = due.length;
    const okIds: string[] = [];
    const pendingIds: string[] = [];
    const errors = new Map<string, string[]>();
    const dead: Array<{ id: string; registeredAt: Date }> = [];
    for (const delivery of due) {
      const receipt = response.receipts.get(delivery.ticketId!);
      if (!receipt) pendingIds.push(delivery.id);
      else if (receipt.ok) okIds.push(delivery.id);
      else {
        errors.set(receipt.error, [
          ...(errors.get(receipt.error) ?? []),
          delivery.id,
        ]);
        if (receipt.error === 'DeviceNotRegistered' && delivery.deviceId)
          dead.push({
            id: delivery.deviceId,
            registeredAt: delivery.createdAt,
          });
      }
    }
    if (okIds.length)
      await this.prisma.pushDelivery.updateMany({
        where: { id: { in: okIds }, status: 'ticket_ok' },
        data: { status: 'receipt_ok', receiptCheckedAt: now },
      });
    for (const [code, ids] of errors)
      await this.prisma.pushDelivery.updateMany({
        where: { id: { in: ids }, status: 'ticket_ok' },
        data: {
          status: 'receipt_error',
          errorCode: code,
          receiptCheckedAt: now,
        },
      });
    if (pendingIds.length)
      await this.prisma.pushDelivery.updateMany({
        where: { id: { in: pendingIds }, status: 'ticket_ok' },
        data: { receiptCheckedAt: now },
      });
    result.ok = okIds.length;
    result.error = [...errors.values()].reduce(
      (total, ids) => total + ids.length,
      0,
    );
    // The send happened at delivery.createdAt: only a registration older than
    // that send is removed.
    result.devicesRemoved = await this.removeDeadDevices(dead);
    return result;
  }

  /** Bounded deletion of outbox rows past retention (deliveries cascade).
   * Final-result rows stay: one per participant and Season, they keep a
   * re-run settlement (which touches `seasons.updated_at`) from announcing
   * the same result again. */
  async prune(now: Date, config: PushNotificationsConfig): Promise<number> {
    const cutoff = new Date(now.getTime() - config.retentionMs);
    let deleted = 0;
    for (let batch = 0; batch < 10; batch++) {
      const count = await this.prisma.$executeRaw`
        DELETE FROM "push_notifications"
        WHERE "id" IN (
          SELECT "id" FROM "push_notifications"
          WHERE "created_at" < ${cutoff}
            AND "type" <> 'season_final_result'
          ORDER BY "created_at"
          LIMIT ${config.retentionBatchSize}
        )`;
      deleted += count;
      if (count < config.retentionBatchSize) break;
    }
    return deleted;
  }
}
