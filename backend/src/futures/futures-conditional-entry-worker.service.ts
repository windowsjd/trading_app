import { publicTradingAccountWhere } from '../seasons/season-availability.policy';
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
import { FuturesConditionalEntryService } from './futures-conditional-entry.service';
import { liveFuturesConditionalEntry } from './futures-conditional-entry-state';

/**
 * Dedicated bounded Futures conditional entry worker, same shape as the
 * conditional BUY worker: 1s polling over indexed live watches (≤100 per
 * cycle, id cursor), one PostgreSQL OpsJobLock lease renewed per watch,
 * centrally collected Futures Last only. It keeps running while the feature is
 * disabled so lifecycle cleanup and stale-trigger failure still happen.
 */
@Injectable()
export class FuturesConditionalEntryWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FuturesConditionalEntryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cursor = '';
  private reportedAt = 0;
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
    private readonly entries: FuturesConditionalEntryService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.error('FUTURES_CONDITIONAL_ENTRY_CYCLE_FAILED'),
      );
    }, 1000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    const lockKey = 'futures_conditional_entries:current';
    let ownerId: string | undefined;
    try {
      const watches = await this.prisma.futuresConditionalEntry.findMany({
        where: {
          tradingAccount: publicTradingAccountWhere(),
          ...liveFuturesConditionalEntry,
          id: { gt: this.cursor },
        },
        orderBy: { id: 'asc' },
        take: 101,
        select: { id: true },
      });
      if (!watches.length) {
        this.cursor = '';
        return;
      }
      const lock = await this.locks.acquireLock({
        jobName: 'futures_conditional_entries',
        lockKey,
        ttlSeconds: 30,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const states: Record<string, number> = {};
      for (const watch of watches.slice(0, 100)) {
        if (
          !(await this.locks.extendLock({ lockKey, ownerId, ttlSeconds: 30 }))
        )
          break;
        let state: string;
        try {
          state = (await this.entries.evaluate(watch.id)).state;
        } catch (error) {
          state = apiErrorCode(
            error,
            'FUTURES_CONDITIONAL_ENTRY_EVALUATION_FAILED',
          );
        }
        states[state] = (states[state] ?? 0) + 1;
        this.cursor = watch.id;
      }
      if (watches.length <= 100) this.cursor = '';
      if (Date.now() - this.reportedAt >= 60000) {
        const run = await this.runs.createRunning({
          jobName: 'futures_conditional_entries',
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
