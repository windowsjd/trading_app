import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { futuresLastPriceRetentionConfig } from './futures-last-price-retention.config';

/** Transport observations have bounded lifetime; financial evidence does not.
 * Never deleted: rows referenced by an execution, Season pin or trigger; any
 * row received in a Season's [endAt-10s, endAt] window (final pins may still
 * need it); the newest row per instrument/source. FK RESTRICT is the final fence. */
@Injectable()
export class FuturesLastPriceRetentionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FuturesLastPriceRetentionService.name);
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

  async run() {
    const config = futuresLastPriceRetentionConfig();
    if (!config.enabled || this.running) return;
    this.running = true;
    const lockKey = 'futures_last_price_retention:current';
    let ownerId: string | undefined;
    let run: Awaited<ReturnType<OpsJobRunService['createRunning']>> | undefined;
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
      const cutoff = new Date(+now - config.hours * 3600000);
      run = await this.runs.createRunning({
        jobName: 'futures_last_price_retention',
        trigger: 'scheduler',
        lockKey,
        dryRun: false,
      });
      let deletedCount = 0;
      let batchCount = 0;
      let lastDeleted = 0;
      for (; batchCount < config.maxBatches; ) {
        if (
          !(await this.locks.extendLock({ lockKey, ownerId, ttlSeconds: 30 }))
        )
          // @diagnosticSurface internal: run catches this fixed lease error and records an Ops failure before stopping deletion.
          throw new Error('FUTURES_LAST_PRICE_RETENTION_LEASE_LOST');
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
      return result;
    } catch (error) {
      if (run)
        await this.runs.recordFailed(run, {
          errorCode: 'FUTURES_LAST_PRICE_RETENTION_FAILED',
          errorMessage: 'Futures Last Price retention failed.',
        });
      throw error;
    } finally {
      try {
        if (ownerId) await this.locks.releaseLock({ lockKey, ownerId });
      } finally {
        this.running = false;
      }
    }
  }

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
        return tx.$executeRaw`
        WITH candidates AS (
          SELECT m.id FROM futures_last_price_snapshots m
          WHERE m.captured_at < ${cutoff} AND m.effective_at < ${cutoff}
            AND NOT EXISTS (SELECT 1 FROM futures_executions e WHERE e.last_price_snapshot_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM futures_season_prices p WHERE p.last_price_snapshot_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM protection_children c WHERE c.futures_last_price_snapshot_id = m.id)
            AND NOT EXISTS (
              SELECT 1 FROM seasons s
              WHERE m.captured_at BETWEEN s.end_at - interval '10 seconds' AND s.end_at
            )
            AND EXISTS (
              SELECT 1 FROM futures_last_price_snapshots newer
              WHERE newer.instrument_id = m.instrument_id AND newer.source = m.source
                AND newer.captured_at > m.captured_at
            )
          ORDER BY m.captured_at, m.id
          LIMIT ${limit} FOR UPDATE OF m SKIP LOCKED
        )
        DELETE FROM futures_last_price_snapshots m USING candidates c WHERE m.id = c.id`;
      },
      { timeout: 10000 },
    );
  }
}
