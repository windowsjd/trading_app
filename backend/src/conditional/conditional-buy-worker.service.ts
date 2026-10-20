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
import { ConditionalBuyService } from './conditional-buy.service';
import { liveConditionalBuy } from './conditional-buy-state';

/**
 * Dedicated bounded conditional BUY worker, same shape as the protection
 * worker: 1s polling over indexed live watches (≤100 per cycle, id cursor),
 * one PostgreSQL OpsJobLock lease renewed per watch, centrally collected
 * prices only. It keeps running while the feature is disabled so lifecycle
 * cleanup and stale-trigger failure still happen.
 */
@Injectable()
export class ConditionalBuyWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConditionalBuyWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cursor = '';
  private reportedAt = 0;
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
    private readonly conditionalBuy: ConditionalBuyService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.error('CONDITIONAL_BUY_CYCLE_FAILED'),
      );
    }, 1000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    const lockKey = 'conditional_buy_orders:current';
    let ownerId: string | undefined;
    try {
      const watches = await this.prisma.conditionalBuyOrder.findMany({
        where: {
          tradingAccount: publicTradingAccountWhere(),
          ...liveConditionalBuy,
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
        jobName: 'conditional_buy_orders',
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
          state = (await this.conditionalBuy.evaluate(watch.id)).state;
        } catch (error) {
          state = apiErrorCode(error, 'CONDITIONAL_BUY_EVALUATION_FAILED');
        }
        states[state] = (states[state] ?? 0) + 1;
        this.cursor = watch.id;
      }
      if (watches.length <= 100) this.cursor = '';
      if (Date.now() - this.reportedAt >= 60000) {
        const run = await this.runs.createRunning({
          jobName: 'conditional_buy_orders',
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
