import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { apiErrorCode } from '../common/api-error-code';
import { FuturesTpSlService } from './futures-tp-sl.service';
import { liveFuturesTpSl } from './futures-tp-sl-state';

/**
 * Dedicated bounded Futures stop-loss/take-profit worker, the same shape as
 * the Futures conditional entry worker: 1s polling over indexed live settings
 * (≤100 per cycle, id cursor), one PostgreSQL OpsJobLock lease renewed per
 * setting, centrally collected Futures Last only. It keeps running while the
 * feature is disabled so lifecycle cleanup, closed-lifetime cleanup and
 * stale-trigger failure still happen.
 */
@Injectable()
export class FuturesTpSlWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FuturesTpSlWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cursor = '';
  private reportedAt = 0;
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
    private readonly settings: FuturesTpSlService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.error('FUTURES_TP_SL_CYCLE_FAILED'),
      );
    }, 1000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    const lockKey = 'futures_tp_sl_settings:current';
    let ownerId: string | undefined;
    try {
      const rows = await this.prisma.futuresTpSlSetting.findMany({
        where: { ...liveFuturesTpSl, id: { gt: this.cursor } },
        orderBy: { id: 'asc' },
        take: 101,
        select: { id: true },
      });
      if (!rows.length) {
        this.cursor = '';
        return;
      }
      const lock = await this.locks.acquireLock({
        jobName: 'futures_tp_sl_settings',
        lockKey,
        ttlSeconds: 30,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const states: Record<string, number> = {};
      for (const row of rows.slice(0, 100)) {
        if (
          !(await this.locks.extendLock({ lockKey, ownerId, ttlSeconds: 30 }))
        )
          break;
        let state: string;
        try {
          state = (await this.settings.evaluate(row.id)).state;
        } catch (error) {
          state = apiErrorCode(error, 'FUTURES_TP_SL_EVALUATION_FAILED');
        }
        states[state] = (states[state] ?? 0) + 1;
        this.cursor = row.id;
      }
      if (rows.length <= 100) this.cursor = '';
      if (Date.now() - this.reportedAt >= 60000) {
        const run = await this.runs.createRunning({
          jobName: 'futures_tp_sl_settings',
          trigger: 'scheduler',
          lockKey,
        });
        await this.runs.recordSucceeded(run, { resultJson: { states } });
        this.reportedAt = Date.now();
      }
      return states;
    } finally {
      try {
        if (ownerId) await this.locks.releaseLock({ lockKey, ownerId });
      } finally {
        this.running = false;
      }
    }
  }
}
