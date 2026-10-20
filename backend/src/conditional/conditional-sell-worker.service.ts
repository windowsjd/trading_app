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
import { ConditionalSellService } from './conditional-sell.service';
import { liveConditionalSell } from './conditional-sell-state';

/**
 * Dedicated bounded SELL intent worker, the same shape as the conditional
 * BUY worker: 1s polling over indexed live intents (≤100 per cycle, id
 * cursor), one PostgreSQL OpsJobLock lease renewed per intent, centrally
 * collected prices only. It keeps running while the features are disabled
 * so lifecycle cleanup, flat-position close and stale-trigger failure still
 * happen.
 */
@Injectable()
export class ConditionalSellWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConditionalSellWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cursor = '';
  private reportedAt = 0;
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
    private readonly conditionalSell: ConditionalSellService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.error('CONDITIONAL_SELL_CYCLE_FAILED'),
      );
    }, 1000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    const lockKey = 'conditional_sell_orders:current';
    let ownerId: string | undefined;
    try {
      const intents = await this.prisma.conditionalSellOrder.findMany({
        where: {
          tradingAccount: publicTradingAccountWhere(),
          ...liveConditionalSell,
          id: { gt: this.cursor },
        },
        orderBy: { id: 'asc' },
        take: 101,
        select: { id: true },
      });
      if (!intents.length) {
        this.cursor = '';
        return;
      }
      const lock = await this.locks.acquireLock({
        jobName: 'conditional_sell_orders',
        lockKey,
        ttlSeconds: 30,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const states: Record<string, number> = {};
      for (const intent of intents.slice(0, 100)) {
        if (
          !(await this.locks.extendLock({ lockKey, ownerId, ttlSeconds: 30 }))
        )
          break;
        let state: string;
        try {
          state = (await this.conditionalSell.evaluate(intent.id)).state;
        } catch (error) {
          state = apiErrorCode(error, 'CONDITIONAL_SELL_EVALUATION_FAILED');
        }
        states[state] = (states[state] ?? 0) + 1;
        this.cursor = intent.id;
      }
      if (intents.length <= 100) this.cursor = '';
      if (Date.now() - this.reportedAt >= 60000) {
        const run = await this.runs.createRunning({
          jobName: 'conditional_sell_orders',
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
