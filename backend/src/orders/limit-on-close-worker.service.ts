import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { projectOpsFailure } from '../ops/ops-failure';
import {
  LimitOnCloseSettlementService,
  type LimitOnCloseCycleSummary,
} from './limit-on-close-settlement.service';

const LOCK_KEY = 'limit_on_close_settlement:current';
const TICK_MS = 15_000;
const LEASE_SECONDS = 120;
const IDLE_REPORT_MS = 600_000;

/**
 * Dedicated bounded LOC settlement worker. Runs regardless of
 * LOC_ORDERS_ENABLED so accepted day orders always fill or release. One
 * instance at a time via the PostgreSQL OpsJobLock lease; an idle probe
 * keeps quiet ticks free of locks and audit rows.
 */
@Injectable()
export class LimitOnCloseWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LimitOnCloseWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private reportedAt = 0;

  constructor(
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
    private readonly settlement: LimitOnCloseSettlementService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.error('LIMIT_ON_CLOSE_CYCLE_FAILED'),
      );
    }, TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<LimitOnCloseCycleSummary | undefined> {
    if (this.running) return;
    this.running = true;
    let ownerId: string | undefined;
    let lease: NodeJS.Timeout | undefined;
    try {
      if (!(await this.settlement.hasDueWork())) return;
      const lock = await this.locks.acquireLock({
        jobName: 'limit_on_close_settlement',
        lockKey: LOCK_KEY,
        ttlSeconds: LEASE_SECONDS,
      });
      if (!lock.acquired) return;
      const owner = lock.ownerId;
      ownerId = owner;
      let owned = true;
      lease = setInterval(
        () => {
          void this.locks
            .extendLock({
              lockKey: LOCK_KEY,
              ownerId: owner,
              ttlSeconds: LEASE_SECONDS,
            })
            .then((extended) => {
              if (!extended) owned = false;
            })
            .catch(() => {
              owned = false;
            });
        },
        (LEASE_SECONDS * 1000) / 4,
      );
      const startedAt = new Date();
      try {
        const summary = await this.settlement.runCycle({
          isLockOwned: () => owned,
        });
        if (
          changed(summary) ||
          Date.now() - this.reportedAt >= IDLE_REPORT_MS
        ) {
          const run = await this.runs.createRunning({
            jobName: 'limit_on_close_settlement',
            trigger: 'scheduler',
            lockKey: LOCK_KEY,
            startedAt,
          });
          await this.runs.recordSucceeded(run, { resultJson: summary });
          this.reportedAt = Date.now();
        }
        return summary;
      } catch (error) {
        const failure = projectOpsFailure(error, 'LIMIT_ON_CLOSE_CYCLE_FAILED');
        const run = await this.runs.createRunning({
          jobName: 'limit_on_close_settlement',
          trigger: 'scheduler',
          lockKey: LOCK_KEY,
          startedAt,
        });
        await this.runs.recordFailed(run, {
          errorCode: failure.code,
          errorMessage: failure.message,
        });
        return;
      }
    } finally {
      if (lease) clearInterval(lease);
      try {
        if (ownerId)
          await this.locks.releaseLock({ lockKey: LOCK_KEY, ownerId });
      } finally {
        this.running = false;
      }
    }
  }
}

function changed(summary: LimitOnCloseCycleSummary) {
  return (
    summary.observations > 0 ||
    summary.filled > 0 ||
    summary.unfilled > 0 ||
    Object.keys(summary.expired).length > 0 ||
    Object.keys(summary.observationFailures).length > 0 ||
    Object.keys(summary.errors).length > 0 ||
    // The run summary is the restart-safe record of US post-final audits.
    summary.postFinalAudited.length > 0
  );
}
