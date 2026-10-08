import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { futuresMarkRetentionConfig } from './futures-mark-retention.config';

/** Transport evidence has bounded lifetime; referenced financial evidence does
 * not. PostgreSQL FK restrictions are the final deletion fence. */
@Injectable()
export class FuturesMarkRetentionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FuturesMarkRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
  ) {}

  onModuleInit() {
    if (futuresMarkRetentionConfig().enabled) {
      this.timer = setInterval(() => {
        void this.run().catch(() =>
          this.logger.error('FUTURES_MARK_RETENTION_FAILED'),
        );
      }, futuresMarkRetentionConfig().intervalMs);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run() {
    const config = futuresMarkRetentionConfig();
    if (!config.enabled || this.running) return;
    this.running = true;
    const lockKey = 'futures_mark_retention:current';
    let ownerId: string | undefined;
    let run: Awaited<ReturnType<OpsJobRunService['createRunning']>> | undefined;
    try {
      const lock = await this.locks.acquireLock({
        jobName: 'futures_mark_retention',
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
        jobName: 'futures_mark_retention',
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
          throw new Error('FUTURES_MARK_RETENTION_LEASE_LOST');
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
          errorCode: 'FUTURES_MARK_RETENTION_FAILED',
          errorMessage: 'Futures Mark retention failed.',
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
      throw new Error('Invalid Futures Mark retention bounds');
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return tx.$executeRaw`
        WITH candidates AS (
          SELECT m.id FROM futures_mark_snapshots m
          WHERE m.captured_at < ${cutoff} AND m.effective_at < ${cutoff}
            AND NOT EXISTS (SELECT 1 FROM futures_liquidation_closes c WHERE c.mark_snapshot_id = m.id)
            AND EXISTS (
              SELECT 1 FROM futures_mark_snapshots newer
              WHERE newer.instrument_id = m.instrument_id AND newer.source = m.source
                AND newer.effective_at > m.effective_at
            )
          ORDER BY m.captured_at, m.id
          LIMIT ${limit} FOR UPDATE OF m SKIP LOCKED
        )
        DELETE FROM futures_mark_snapshots m USING candidates c WHERE m.id = c.id`;
      },
      { timeout: 10000 },
    );
  }
}
