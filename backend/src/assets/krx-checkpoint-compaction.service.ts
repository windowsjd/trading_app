import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AssetType,
  MarketCandleSyncMode,
  MarketCandleSyncStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  KOSCOM_HISTORY_SOURCE,
  KOSCOM_MINUTE_SOURCE,
} from '../providers/koscom/koscom.config';
import { kstDate, kstDayStartMs } from './krx-candle-collection.policy';
import {
  planCheckpointCompaction,
  type CompactionRow,
} from './krx-checkpoint-compaction';
import {
  KRX_CENTRAL_CANDLES_CONFIG,
  resolveKrxObligationStart,
  type KrxCentralCandlesConfig,
} from './krx-central-candles.config';
import { MarketCandleBackfillLockService } from './market-candle-backfill-lock.service';
import { readMarketCandleRetentionConfig } from './market-candle-retention.config';

const DAY_MS = 24 * 60 * 60_000;
const FEEDS = [
  { feed: '5m', sourceProvider: KOSCOM_MINUTE_SOURCE, retention: true },
  { feed: '1d', sourceProvider: KOSCOM_HISTORY_SOURCE, retention: false },
] as const;

export type KrxCompactionSummary = {
  assets: number;
  seriesCompacted: number;
  seriesSkipped: { assetId: string; feed: string; reason: string }[];
  rowsDeleted: number;
  rowsMerged: number;
  rowsInserted: number;
};

/**
 * Daily KRX checkpoint compaction (design v2.1 §4.4; 05:00 KST, after the
 * 5m retention). Keeps the coverage-union input bounded (F19: ≈ 8,100 → 200
 * rows/day at 100 symbols) without changing any reader result. Each
 * asset/feed is planned and applied under its backfill lock, the merge
 * insert and the deletes in one transaction.
 */
@Injectable()
export class KrxCheckpointCompactionService {
  private readonly logger = new Logger(KrxCheckpointCompactionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: MarketCandleBackfillLockService,
    @Inject(KRX_CENTRAL_CANDLES_CONFIG)
    private readonly config: KrxCentralCandlesConfig,
  ) {}

  async run(input: {
    now: Date;
    dryRun?: boolean;
    signal?: AbortSignal;
  }): Promise<KrxCompactionSummary> {
    const cutoffMs = kstDayStartMs(kstDate(input.now.getTime()));
    const baselineMs =
      input.now.getTime() -
      readMarketCandleRetentionConfig().retentionDays * DAY_MS;
    const assets = await this.prisma.asset.findMany({
      where: { assetType: AssetType.domestic_stock },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: { id: true, symbol: true },
    });
    const summary: KrxCompactionSummary = {
      assets: assets.length,
      seriesCompacted: 0,
      seriesSkipped: [],
      rowsDeleted: 0,
      rowsMerged: 0,
      rowsInserted: 0,
    };
    for (const asset of assets) {
      for (const { feed, sourceProvider, retention } of FEEDS) {
        if (input.signal?.aborted) return summary;
        const lock = await this.locks.acquire({
          assetId: asset.id,
          feed,
          ttlSeconds: 120,
          renewSeconds: 60,
          now: input.now,
        });
        if (!lock.acquired) {
          summary.seriesSkipped.push({
            assetId: asset.id,
            feed,
            reason: lock.reason === 'busy' ? 'LOCK_BUSY' : 'LOCK_UNAVAILABLE',
          });
          continue;
        }
        try {
          const start =
            feed === '5m'
              ? resolveKrxObligationStart(this.config, asset.symbol)
              : null;
          const rows = await this.loadRows(asset.id, feed);
          const plan = planCheckpointCompaction(rows, {
            cutoffMs,
            obligationStartMs: start?.getTime() ?? null,
            retentionBaselineMs: retention ? baselineMs : null,
          });
          if (plan.unresolvedIds.length > 0) {
            summary.seriesSkipped.push({
              assetId: asset.id,
              feed,
              reason: 'UNRESOLVED_OLD_RUNS',
            });
            this.logger.warn(
              JSON.stringify({
                event: 'krx_checkpoint_compaction_skipped',
                assetId: asset.id,
                feed,
                unresolvedRuns: plan.unresolvedIds.length,
              }),
            );
          }
          if (plan.deleteIds.length === 0) continue;
          summary.seriesCompacted += 1;
          summary.rowsDeleted += plan.deleteIds.length;
          summary.rowsMerged += plan.merges.reduce(
            (sum, merge) => sum + merge.memberIds.length,
            0,
          );
          summary.rowsInserted += plan.merges.length;
          if (input.dryRun) continue;
          await this.prisma.$transaction(async (tx) => {
            for (const merge of plan.merges)
              await tx.marketCandleSyncState.create({
                data: {
                  assetId: asset.id,
                  feed,
                  sourceProvider,
                  mode: MarketCandleSyncMode.repair,
                  status: MarketCandleSyncStatus.completed,
                  targetFrom: new Date(merge.from),
                  targetTo: new Date(merge.to),
                  coveredFrom: new Date(merge.from),
                  coveredTo: new Date(merge.to),
                  coverageComplete: true,
                  completionReason: 'target_reached',
                  completedAt: new Date(merge.completedAt),
                  createdAt: new Date(merge.createdAt),
                  cursorJson: {
                    compacted: {
                      rows: merge.memberIds.length,
                      from: new Date(merge.from).toISOString(),
                      to: new Date(merge.to).toISOString(),
                      firstCreatedAt: new Date(
                        merge.firstCreatedAt,
                      ).toISOString(),
                    },
                  },
                },
              });
            await tx.marketCandleSyncState.deleteMany({
              where: { id: { in: plan.deleteIds }, assetId: asset.id, feed },
            });
          });
        } finally {
          await this.locks.release(lock.handle);
        }
      }
    }
    return summary;
  }

  private async loadRows(
    assetId: string,
    feed: string,
  ): Promise<CompactionRow[]> {
    const rows = await this.prisma.marketCandleSyncState.findMany({
      where: { assetId, feed },
      select: {
        id: true,
        status: true,
        coverageComplete: true,
        targetFrom: true,
        targetTo: true,
        coveredFrom: true,
        coveredTo: true,
        createdAt: true,
        completedAt: true,
        cursorJson: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      coverageComplete: row.coverageComplete,
      targetFrom: row.targetFrom.getTime(),
      targetTo: row.targetTo.getTime(),
      coveredFrom: row.coveredFrom?.getTime() ?? null,
      coveredTo: row.coveredTo?.getTime() ?? null,
      createdAt: row.createdAt.getTime(),
      completedAt: row.completedAt?.getTime() ?? null,
      auditMiss: typeof cursorOf(row.cursorJson).auditFirstMissing === 'string',
      firstCreatedAt: compactedFirstCreatedAt(row.cursorJson) ?? undefined,
    }));
  }
}

function cursorOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A merged row's group-earliest createdAt (G4-I collection start). */
export function compactedFirstCreatedAt(cursorJson: unknown): number | null {
  const compacted = cursorOf(cursorOf(cursorJson).compacted);
  const ms =
    typeof compacted.firstCreatedAt === 'string'
      ? Date.parse(compacted.firstCreatedAt)
      : NaN;
  return Number.isFinite(ms) ? ms : null;
}
