import {
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { FuturesLimitService } from './futures-limit.service';

const ENTRIES_PER_CYCLE = 200;

@Injectable()
export class FuturesLimitWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FuturesLimitWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cursor = '';
  private reportedAt = 0;
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
    private readonly entries: FuturesLimitService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.error('FUTURES_LIMIT_CYCLE_FAILED'),
      );
    }, 1000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    const lockKey = 'futures_limit_matching:current';
    let ownerId: string | undefined;
    try {
      // Remain operational for lifecycle cleanup when user feature is disabled.
      const groups = await this.prisma.futuresLimitOrder.findMany({
        where: { status: 'submitted', id: { gt: this.cursor } },
        orderBy: { id: 'asc' },
        take: ENTRIES_PER_CYCLE + 1,
        select: { id: true },
      });
      if (!groups.length) {
        this.cursor = '';
        return;
      }
      const lock = await this.locks.acquireLock({
        jobName: 'futures_limit_matching',
        lockKey,
        ttlSeconds: 30,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const states: Record<string, number> = {};
      for (const group of groups.slice(0, ENTRIES_PER_CYCLE)) {
        if (
          !(await this.locks.extendLock({ lockKey, ownerId, ttlSeconds: 30 }))
        )
          break;
        let state: string;
        try {
          state = (await this.entries.evaluate(group.id)).state;
        } catch (error) {
          const response =
            error instanceof HttpException
              ? (error.getResponse() as { error?: { code?: unknown } })
              : null;
          const code = response?.error?.code;
          state =
            typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
              ? code
              : 'FUTURES_LIMIT_EVALUATION_FAILED';
        }
        states[state] = (states[state] ?? 0) + 1;
        this.cursor = group.id;
      }
      if (groups.length <= ENTRIES_PER_CYCLE) this.cursor = '';
      if (Date.now() - this.reportedAt >= 60000) {
        const run = await this.runs.createRunning({
          jobName: 'futures_limit_matching',
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
