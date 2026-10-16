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
import { futuresLastPriceRetentionConfig } from './futures-last-price-retention.config';
import {
  RetentionHealth,
  type RetentionFailureKind,
} from './futures-retention-health';

/** Transport observations have bounded lifetime; financial evidence does not.
 * Never deleted: rows referenced by an execution, Season pin or trigger; any
 * row received in a Season's [endAt-10s, endAt] window (final pins may still
 * need it); the newest row per instrument/source. FK RESTRICT is the final fence. */
@Injectable()
export class FuturesLastPriceRetentionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FuturesLastPriceRetentionService.name);
  private readonly health = new RetentionHealth(
    'futures_last_price_retention',
    this.logger,
  );
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
  ) {}

  onModuleInit() {
    if (futuresLastPriceRetentionConfig().enabled) {
      this.timer = setInterval(() => {
        void this.run().catch(() =>
          this.logger.error('FUTURES_LAST_PRICE_RETENTION_FAILED'),
        );
      }, futuresLastPriceRetentionConfig().intervalMs);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  getStatus() {
    return {
      enabled: futuresLastPriceRetentionConfig().enabled,
      ...this.health.status(),
    };
  }

  async run() {
    const config = futuresLastPriceRetentionConfig();
    if (!config.enabled || this.running) return;
    this.running = true;
    const lockKey = 'futures_last_price_retention:current';
    let ownerId: string | undefined;
    let run: Awaited<ReturnType<OpsJobRunService['createRunning']>> | undefined;
    let cutoff: Date | undefined;
    let deletedCount = 0;
    let batchCount = 0;
    let leaseLost = false;
    try {
      const lock = await this.locks.acquireLock({
        jobName: 'futures_last_price_retention',
        lockKey,
        ttlSeconds: 30,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const now = (
        await this.prisma.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`
      )[0].now;
      cutoff = new Date(+now - config.hours * 3600000);
      run = await this.runs.createRunning({
        jobName: 'futures_last_price_retention',
        trigger: 'scheduler',
        lockKey,
        dryRun: false,
      });
      let lastDeleted = 0;
      for (; batchCount < config.maxBatches; ) {
        if (
          !(await this.locks.extendLock({ lockKey, ownerId, ttlSeconds: 30 }))
        ) {
          leaseLost = true;
          // @diagnosticSurface internal: run catches this fixed lease error and records an Ops failure before stopping deletion.
          throw new Error('FUTURES_LAST_PRICE_RETENTION_LEASE_LOST');
        }
        lastDeleted = await this.deleteBatch(cutoff, config.batchSize);
        deletedCount += lastDeleted;
        batchCount++;
        if (lastDeleted < config.batchSize) break;
      }
      const result = {
        cutoff: cutoff.toISOString(),
        deletedCount,
        batchCount,
        batchLimitReached:
          lastDeleted === config.batchSize && batchCount === config.maxBatches,
      };
      await this.runs.recordSucceeded(run, { resultJson: result });
      this.health.succeeded(result.batchLimitReached);
      return result;
    } catch (error) {
      const kind: RetentionFailureKind = leaseLost
        ? 'lease_lost'
        : databaseFailureKind(error);
      if (run)
        await this.runs.recordFailed(run, {
          errorCode: 'FUTURES_LAST_PRICE_RETENTION_FAILED',
          errorMessage: 'Futures Last Price retention failed.',
          // Committed batches before the failure stay deleted; the next run resumes.
          resultJson: {
            cutoff: cutoff?.toISOString() ?? null,
            deletedCount,
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

  /** One bounded batch, oldest receipt first, from ONE ordered range scan of
   * (captured_at, id) that stops at the LIMIT: no self-join, no full-table
   * hash or sort however large the backlog. The newest row per
   * instrument/source is read by an index-backed LATERAL LIMIT 1 per pair in
   * the same snapshot. effective_at <= captured_at is a table CHECK, so the
   * receipt range bounds both times; the DELETE still re-checks effective_at. */
  async deleteBatch(cutoff: Date, limit: number): Promise<number> {
    if (
      !Number.isFinite(+cutoff) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10000
    )
      // @diagnosticSurface internal: Internal batch API; scheduler run projects failures through OpsJobRunService.
      throw new Error('Invalid Futures Last Price retention bounds');
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return tx.$executeRaw(futuresLastPriceRetentionBatchSql(cutoff, limit));
      },
      { timeout: 10000 },
    );
  }
}

/** The exact batch statement FuturesLastPriceRetentionService.deleteBatch runs, exported so
 * PostgreSQL tests can EXPLAIN the production SQL itself. */
export function futuresLastPriceRetentionBatchSql(cutoff: Date, limit: number) {
  return Prisma.sql`
        WITH candidates AS (
          SELECT m.id FROM futures_last_price_snapshots m
          WHERE m.captured_at < ${cutoff}
            AND m.id <> ALL (ARRAY(
              SELECT newest.id FROM futures_instruments i
              CROSS JOIN unnest(enum_range(NULL::"FuturesLastPriceSource")) AS s(source)
              CROSS JOIN LATERAL (
                SELECT n.id FROM futures_last_price_snapshots n
                -- Range, not equality, on source: the (source, captured_at) order then
                -- only fits the unique index, so the planner can never walk a whole
                -- instrument through another index for a source it rarely holds.
                WHERE n.instrument_id = i.id AND n.source >= s.source AND n.source <= s.source
                ORDER BY n.source DESC, n.captured_at DESC LIMIT 1
              ) newest
            ))
            AND NOT EXISTS (SELECT 1 FROM futures_executions e WHERE e.last_price_snapshot_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM futures_season_prices p WHERE p.last_price_snapshot_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM protection_children c WHERE c.futures_last_price_snapshot_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM futures_conditional_entries ce WHERE ce.registration_snapshot_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM futures_conditional_entries ce WHERE ce.trigger_snapshot_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM futures_tp_sl_settings ts WHERE ts.registration_snapshot_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM futures_tp_sl_settings ts WHERE ts.trigger_snapshot_id = m.id)
            AND NOT EXISTS (
              SELECT 1 FROM seasons s
              WHERE m.captured_at BETWEEN s.end_at - interval '10 seconds' AND s.end_at
            )
          ORDER BY m.captured_at, m.id
          LIMIT ${limit} FOR UPDATE OF m SKIP LOCKED
        )
        -- An array of the locked ids, not a join to the CTE: a join is costed
        -- from table size, and on a table small relative to the batch it hashes a
        -- full scan of the table. The array keeps the DELETE on the primary key.
        DELETE FROM futures_last_price_snapshots m
        WHERE m.id = ANY (ARRAY(SELECT c.id FROM candidates c))
          AND m.effective_at < ${cutoff}`;
}
