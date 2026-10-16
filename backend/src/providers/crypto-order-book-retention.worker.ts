import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { databaseFailureKind } from '../common/database-failure';
import {
  RetentionHealth,
  type RetentionFailureKind,
} from '../futures/futures-retention-health';
import { cryptoOrderBookHistoryConfig } from './crypto-order-book-history.config';

/** The only tables this job ever deletes from: the crypto order-book
 * history. KOSCOM/KIS books (asset_orderbook_snapshots), prices and every
 * financial table are outside its reach. */
export const CRYPTO_ORDER_BOOK_HISTORY_TABLES = {
  spot: 'crypto_spot_order_book_snapshots',
  futures: 'futures_order_book_snapshots',
} as const;
type Market = keyof typeof CRYPTO_ORDER_BOOK_HISTORY_TABLES;

/** A row goes once its whole minute is older than the retention, so no book
 * captured within the last 336 hours is ever deleted. */
export function cryptoOrderBookDeleteBefore(cutoff: Date, bucketMs = 60_000) {
  return new Date(Math.floor(+cutoff / bucketMs) * bucketMs);
}

/** One bounded batch: the oldest rows, read in primary-key order (minute
 * first), locked, then deleted by row address. Nothing references these
 * tables, so no reference protection is needed. Exported for the plan tests. */
export function cryptoOrderBookRetentionBatchSql(
  market: Market,
  deleteBefore: Date,
  limit: number,
) {
  const table = Prisma.raw(`"${CRYPTO_ORDER_BOOK_HISTORY_TABLES[market]}"`);
  return Prisma.sql`
    WITH candidates AS (
      SELECT ctid FROM ${table}
      WHERE bucket_start_at < ${deleteBefore}
      ORDER BY bucket_start_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM ${table}
    WHERE ctid = ANY(ARRAY(SELECT ctid FROM candidates))
      AND bucket_start_at < ${deleteBefore}`;
}

/** Scheduled 14-day retention of the crypto order-book history. Every five
 * minutes one instance (Ops lease) deletes rows older than 336 hours in
 * bounded batches, each in its own transaction, so a failure, a lost lease or
 * a restart resumes from the database state. */
@Injectable()
export class CryptoOrderBookRetentionWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CryptoOrderBookRetentionWorker.name);
  private readonly health = new RetentionHealth(
    'crypto_order_book_retention',
    this.logger,
    'crypto_order_book_retention',
  );
  private phase?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastResult: Record<string, unknown> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
  ) {}

  onModuleInit() {
    const { retentionEnabled, retentionIntervalMs } =
      cryptoOrderBookHistoryConfig();
    if (!retentionEnabled) return;
    const tick = () =>
      void this.run().catch(() =>
        this.logger.error('CRYPTO_ORDER_BOOK_RETENTION_FAILED'),
      );
    // 45 s off the other retention ticks (Futures Last :00, price :15, Mark
    // :30 of the process minute), so the DELETE bursts never share a second.
    this.phase = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, retentionIntervalMs);
    }, 45000);
  }

  onModuleDestroy() {
    if (this.phase) clearTimeout(this.phase);
    if (this.timer) clearInterval(this.timer);
  }

  getStatus() {
    const { retentionEnabled, retentionHours } = cryptoOrderBookHistoryConfig();
    return {
      enabled: retentionEnabled,
      retentionHours,
      lastResult: this.lastResult,
      ...this.health.status(),
    };
  }

  async run() {
    const config = cryptoOrderBookHistoryConfig();
    if (!config.retentionEnabled || this.running) return;
    this.running = true;
    const started = Date.now();
    const lockKey = 'crypto_order_book_retention:current';
    let ownerId: string | undefined;
    let run: Awaited<ReturnType<OpsJobRunService['createRunning']>> | undefined;
    let cutoff: Date | undefined;
    const deleted: Record<Market, number> = { spot: 0, futures: 0 };
    let batchCount = 0;
    let leaseLost = false;
    try {
      const lock = await this.locks.acquireLock({
        jobName: 'crypto_order_book_retention',
        lockKey,
        ttlSeconds: 60,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      // Database time, so an application clock step never moves the cutoff.
      const now = (
        await this.prisma.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`
      )[0].now;
      cutoff = new Date(+now - config.retentionHours * 3_600_000);
      const deleteBefore = cryptoOrderBookDeleteBefore(cutoff, config.bucketMs);
      run = await this.runs.createRunning({
        jobName: 'crypto_order_book_retention',
        trigger: 'scheduler',
        lockKey,
        dryRun: false,
      });
      let capped = false;
      for (const market of ['spot', 'futures'] as const) {
        for (;;) {
          if (
            deleted.spot + deleted.futures >= config.retentionMaxRowsPerRun ||
            Date.now() - started >= config.retentionMaxRunMs
          ) {
            capped = true;
            break;
          }
          if (
            !(await this.locks.extendLock({ lockKey, ownerId, ttlSeconds: 60 }))
          ) {
            leaseLost = true;
            // @diagnosticSurface internal: run catches this fixed lease error and records an Ops failure before stopping deletion.
            throw new Error('CRYPTO_ORDER_BOOK_RETENTION_LEASE_LOST');
          }
          const count = await this.deleteBatch(
            market,
            deleteBefore,
            config.retentionBatchSize,
          );
          batchCount++;
          deleted[market] += count;
          if (count < config.retentionBatchSize) break;
        }
        if (capped) break;
      }
      const oldestRemaining = await this.oldestRemaining();
      const result = {
        cutoff: cutoff.toISOString(),
        deleteBefore: deleteBefore.toISOString(),
        deletedCount: deleted.spot + deleted.futures,
        deleted,
        batchCount,
        batchLimitReached: capped,
        oldestRemaining,
      };
      await this.runs.recordSucceeded(run, { resultJson: result });
      this.lastResult = result;
      this.health.succeeded(capped);
      return result;
    } catch (error) {
      const kind: RetentionFailureKind = leaseLost
        ? 'lease_lost'
        : databaseFailureKind(error);
      if (run)
        await this.runs.recordFailed(run, {
          errorCode: 'CRYPTO_ORDER_BOOK_RETENTION_FAILED',
          errorMessage: 'Crypto order book retention failed.',
          // Committed batches before the failure stay deleted; the next run resumes.
          resultJson: {
            cutoff: cutoff?.toISOString() ?? null,
            deletedCount: deleted.spot + deleted.futures,
            deleted,
            batchCount,
            failureKind: kind,
          },
        });
      this.health.failed(kind);
      throw error;
    } finally {
      try {
        if (ownerId) await this.locks.releaseLock({ lockKey, ownerId });
      } finally {
        this.running = false;
      }
    }
  }

  private deleteBatch(market: Market, deleteBefore: Date, limit: number) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return tx.$executeRaw(
          cryptoOrderBookRetentionBatchSql(market, deleteBefore, limit),
        );
      },
      { timeout: 10_000 },
    );
  }

  /** Oldest stored minute per table (one primary-key descent each): the
   * retention lag is visible in ops_job_runs and /readiness. */
  private async oldestRemaining() {
    const [row] = await this.prisma.$queryRaw<
      Array<{ spot: Date | null; futures: Date | null }>
    >`SELECT
        (SELECT min(bucket_start_at) FROM crypto_spot_order_book_snapshots) AS spot,
        (SELECT min(bucket_start_at) FROM futures_order_book_snapshots) AS futures`;
    return {
      spot: row?.spot?.toISOString() ?? null,
      futures: row?.futures?.toISOString() ?? null,
    };
  }
}
