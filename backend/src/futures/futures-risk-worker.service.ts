import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  HttpException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { FuturesLiquidationService } from './futures-liquidation.service';
import { futuresRiskConfig } from './futures.config';

@Injectable()
export class FuturesRiskWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FuturesRiskWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cursor = '';
  private lastReport = 0;
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OpsJobLockService,
    private readonly runs: OpsJobRunService,
    private readonly liquidation: FuturesLiquidationService,
  ) {}
  onModuleInit() {
    if (futuresRiskConfig().enabled)
      this.timer = setInterval(() => {
        void this.tick().catch(() =>
          this.logger.error('FUTURES_RISK_CYCLE_FAILED'),
        );
      }, futuresRiskConfig().intervalMs);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running || !futuresRiskConfig().enabled) return;
    this.running = true;
    const startedAt = new Date();
    const key = 'futures_liquidation:current';
    let ownerId: string | undefined;
    try {
      const lock = await this.locks.acquireLock({
        jobName: 'futures_liquidation',
        lockKey: key,
        ttlSeconds: 30,
      });
      if (!lock.acquired) return;
      ownerId = lock.ownerId;
      const accounts = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT trading_account_id AS id FROM futures_positions
        WHERE status = 'open' AND trading_account_id > ${this.cursor}
        ORDER BY trading_account_id LIMIT ${futuresRiskConfig().batchSize}`;
      if (!accounts.length) {
        this.cursor = '';
        return;
      }
      const results: Array<{
        accountId: string;
        scope: string;
        state: string;
      }> = [];
      for (const account of accounts) {
        if (
          !(await this.locks.extendLock({
            lockKey: key,
            ownerId,
            ttlSeconds: 30,
          }))
        )
          break;
        const positions = await this.prisma.futuresPosition.findMany({
          where: { tradingAccountId: account.id, status: 'open' },
          select: { id: true, marginMode: true },
          orderBy: { id: 'asc' },
        });
        const scopes = [
          ...new Set(
            positions.map((p) => (p.marginMode === 'cross' ? 'cross' : p.id)),
          ),
        ];
        for (const scope of scopes) {
          if (
            !(await this.locks.extendLock({
              lockKey: key,
              ownerId,
              ttlSeconds: 30,
            }))
          )
            break;
          try {
            const result = await this.liquidation.liquidate(account.id, scope);
            results.push({ accountId: account.id, scope, state: result.state });
          } catch (error) {
            results.push({
              accountId: account.id,
              scope,
              state: riskFailureState(error),
            });
          }
        }
        this.cursor = account.id;
      }
      if (accounts.length < futuresRiskConfig().batchSize) this.cursor = '';
      // Bounded durable diagnostics; no idle write every second.
      if (
        results.some((r) => r.state === 'liquidated') ||
        Date.now() - this.lastReport >= 60000
      ) {
        const run = await this.runs.createRunning({
          jobName: 'futures_liquidation',
          trigger: 'scheduler',
          lockKey: key,
          dryRun: false,
          startedAt,
        });
        await this.runs.recordSucceeded(run, {
          resultJson: { results, nextAccountCursor: this.cursor },
        });
        this.lastReport = Date.now();
      }
    } finally {
      try {
        if (ownerId) await this.locks.releaseLock({ lockKey: key, ownerId });
      } finally {
        this.running = false;
      }
    }
  }
}

// Ops retains its account/scope identifiers. Exception fields are untrusted,
// including a value shaped like a domain code; never store arbitrary prose.
const SAFE_RISK_FAILURE_CODES = new Set([
  'FUTURES_MARK_STALE',
  'FUTURES_MARK_UNAVAILABLE',
  'FUTURES_FEE_POLICY_INVALID',
  'FUTURES_COLLATERAL_INTEGRITY',
  'FUTURES_CASH_CONFLICT',
  'FUTURES_VALUE_OUT_OF_RANGE',
  'FUTURES_POSITION_NOT_FOUND',
  'FUTURES_ONE_WAY_VIOLATION',
  'FUTURES_LEVERAGE_MISMATCH',
  'FUTURES_MARGIN_MODE_MISMATCH',
  'INVALID_FUTURES_REDUCE_QUANTITY',
  'FINANCIAL_SCOPE_REPAIR_REQUIRED',
  'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
  'TRADING_ACCOUNT_LINK_INTEGRITY',
  'TRADING_ACCOUNT_SCOPE_MISMATCH',
  'GENERAL_ACCOUNT_INTEGRITY',
  'PARTICIPANT_NOT_FOUND',
  'SEASON_NOT_ACTIVE',
]);

function riskFailureState(error: unknown): string {
  const response: unknown =
    error instanceof HttpException ? error.getResponse() : null;
  if (response && typeof response === 'object' && 'error' in response) {
    const body: unknown = response.error;
    if (body && typeof body === 'object' && 'code' in body) {
      const code: unknown = body.code;
      if (typeof code === 'string' && SAFE_RISK_FAILURE_CODES.has(code))
        return code;
    }
  }
  return 'FUTURES_RISK_TRANSACTION_FAILED';
}
