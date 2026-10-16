import { HttpStatus, Injectable } from '@nestjs/common';
import { apiErrorCode } from '../common/api-error-code';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { buildPagination } from '../common/pagination';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { assertBeginnerLearningAccess } from '../trading-accounts/beginner-learning-policy';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { conditionalTradable } from '../conditional/conditional-policy';
import { findProtectionSettingConflict } from '../conditional/conditional-sell-policy';
import { liveProtection } from '../conditional/conditional-state';
import { futuresError } from './futures-error';
import { assertFuturesOperation, futuresTradingMode } from './futures.config';
import { readFuturesLastPrice } from './futures-last-price';
import { FuturesService } from './futures.service';
import {
  futuresInstrumentInclude,
  presentFuturesInstrument,
} from './futures.presenter';
import {
  assertFuturesTpSlEnabled,
  FUTURES_TP_SL_EXECUTION_FAILED,
  FUTURES_TP_SL_MAX_ATTEMPTS,
  FUTURES_TP_SL_MAX_LIVE_PER_ACCOUNT,
  futuresTpSlCondition,
  futuresTpSlEnabled,
  futuresTpSlHash,
  futuresTpSlWindowExpired,
  isFuturesTpSlMet,
  isRetryableFuturesTpSlFailure,
  parseFuturesTpSlBody,
  resolveFuturesTpSlExecution,
} from './futures-tp-sl-policy';
import {
  liveFuturesTpSl,
  type FuturesTpSlLifecycleReason,
} from './futures-tp-sl-state';

const TP_SL_INCLUDE = {
  instrument: { include: futuresInstrumentInclude },
  execution: {
    select: {
      id: true,
      operation: true,
      executionPrice: true,
      quantity: true,
      feeAmount: true,
      realizedPnl: true,
      positionQuantityAfter: true,
      executedAt: true,
    },
  },
  entryPlan: { select: { id: true, ratioPercent: true } },
} as const;

type TpSlRecord = Prisma.FuturesTpSlSettingGetPayload<{
  include: typeof TP_SL_INCLUDE;
}>;

type PositionFacts = { id: string; quantity: Prisma.Decimal };

type ListQuery = {
  limit?: string;
  offset?: string;
  state?: string;
  positionId?: string;
  instrumentId?: string;
};

/**
 * Independent stop-loss / take-profit settings on one open Futures position
 * lifetime: each has its own target quantity, none reserves anything, and
 * one firing never cancels another. Once its fresh Futures Last trigger is
 * recorded a setting reduces (or, for the whole remainder, closes) the
 * position through the existing FuturesService — same Futures Last
 * execution price, fee, PnL, ledger, collateral and fill-count cores, Mark
 * stays the risk price — for min(target, position) at that moment. It never
 * opens, increases or flips a position and never changes leverage or margin
 * mode. Lifecycle authorization uses the existing Season → Account →
 * Participant / General Account fence.
 */
@Injectable()
export class FuturesTpSlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly futures: FuturesService,
  ) {}

  async create(userId: string | undefined, accountId: string, body: unknown) {
    this.user(userId);
    const input = parseFuturesTpSlBody(body);
    const hash = futuresTpSlHash(accountId, input);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      const committed = await tx.futuresTpSlSetting.findMany({
        where: {
          tradingAccountId: accountId,
          idempotencyKey: input.idempotencyKey,
        },
        include: TP_SL_INCLUDE,
        orderBy: { kind: 'asc' },
      });
      if (committed.length) {
        if (committed.some((row) => row.requestHash !== hash))
          futuresError(
            'FUTURES_IDEMPOTENCY_CONFLICT',
            'This request conflicts with an earlier Futures command.',
          );
        return this.response(
          accountId,
          committed,
          true,
          await this.positions(accountId, committed, tx),
        );
      }
      assertFuturesTpSlEnabled();
      // Reduce-only automation: allowed in ENABLED and REDUCE_ONLY.
      assertFuturesOperation('reduce');
      const now = await this.futures.dbNow(tx);
      const account = await this.access.getOwnedAccountOrThrow(
        userId,
        accountId,
        tx,
      );
      if (!conditionalTradable(account, now))
        futuresError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
        );
      await assertBeginnerLearningAccess(tx, account, 'allTrading');
      // Same order as a Futures execution: account fence → wallet → position.
      await tx.$queryRaw`SELECT id FROM cash_wallets WHERE trading_account_id = ${accountId} AND wallet_scope = 'crypto_futures' AND currency_code = 'USD' FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM futures_positions WHERE id = ${input.positionId} AND trading_account_id = ${accountId} FOR UPDATE`;
      const position = await tx.futuresPosition.findFirst({
        where: {
          id: input.positionId,
          tradingAccountId: accountId,
          status: 'open',
        },
      });
      if (!position)
        futuresError(
          'FUTURES_TP_SL_POSITION_UNAVAILABLE',
          'An open Futures position is required.',
        );
      const instrument = await this.futures.instrument(
        tx,
        position.instrumentId,
      );
      // A whole-lifetime OCO group and independent settings never share a
      // lifetime: its exit closes the whole position.
      if (
        await tx.protectionGroup.count({
          where: { futuresPositionId: position.id, ...liveProtection },
        })
      )
        futuresError(
          'PROTECTION_CONFLICT',
          'Cancel the existing TP/SL protection before adding stop-loss or take-profit settings.',
        );
      const live = await tx.futuresTpSlSetting.count({
        where: { tradingAccountId: accountId, ...liveFuturesTpSl },
      });
      if (live + input.intents.length > FUTURES_TP_SL_MAX_LIVE_PER_ACCOUNT)
        futuresError(
          'FUTURES_TP_SL_LIMIT_EXCEEDED',
          'Too many active Futures stop-loss and take-profit settings.',
        );
      // Each target alone, then per kind with the live settings of this
      // lifetime (stop-losses and take-profits are summed separately).
      if (input.intents.some((intent) => intent.quantity.gt(position.quantity)))
        futuresError(
          'FUTURES_TP_SL_QUANTITY_EXCEEDS_POSITION',
          'The quantity exceeds the open position.',
        );
      const conflict = findProtectionSettingConflict({
        intents: input.intents,
        live: await tx.futuresTpSlSetting.findMany({
          where: {
            positionId: position.id,
            kind: { in: input.intents.map((intent) => intent.kind) },
            ...liveFuturesTpSl,
          },
          select: { kind: true, triggerPrice: true, quantity: true },
        }),
        holding: position.quantity,
      });
      if (conflict === 'duplicate_price')
        futuresError(
          'FUTURES_TP_SL_DUPLICATE_PRICE',
          'An active setting of the same kind already uses this price.',
        );
      if (conflict === 'total_exceeds_holding')
        futuresError(
          'FUTURES_TP_SL_TOTAL_EXCEEDS_POSITION',
          'Active settings of the same kind would exceed the open position.',
        );
      setAdminDiagnosticContext({
        domain: 'futures',
        operation: 'FUTURES_TP_SL_CREATE',
        failureStage: 'futures_tp_sl_price_selection',
        entities: { tradingAccountId: accountId, instrumentId: instrument.id },
      });
      const price = (await readFuturesLastPrice(tx, instrument, now))!;
      if (
        input.intents.some((intent) =>
          isFuturesTpSlMet(
            position.direction,
            intent.kind,
            price.price,
            intent.triggerPrice,
          ),
        )
      )
        futuresError(
          'FUTURES_TP_SL_ALREADY_MET',
          'The current Futures Last already meets this setting.',
        );
      const rows: TpSlRecord[] = [];
      for (const intent of input.intents)
        rows.push(
          await tx.futuresTpSlSetting.create({
            data: {
              tradingAccountId: accountId,
              instrumentId: position.instrumentId,
              positionId: position.id,
              direction: position.direction,
              kind: intent.kind,
              triggerPrice: intent.triggerPrice,
              quantity: intent.quantity,
              registrationSnapshotId: price.id,
              idempotencyKey: input.idempotencyKey,
              requestHash: hash,
              createdAt: now,
            },
            include: TP_SL_INCLUDE,
          }),
        );
      if (!conditionalTradable(account, await this.futures.dbNow(tx)))
        futuresError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
        );
      return this.response(
        accountId,
        rows,
        false,
        new Map([[position.id, position]]),
      );
    });
  }

  async cancel(userId: string | undefined, accountId: string, id: string) {
    this.user(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      await tx.$queryRaw`SELECT "id" FROM "futures_tp_sl_settings" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
      const row = await tx.futuresTpSlSetting.findFirst({
        where: { id, tradingAccountId: accountId },
        include: TP_SL_INCLUDE,
      });
      if (!row)
        futuresError(
          'FUTURES_TP_SL_NOT_FOUND',
          'Stop-loss or take-profit setting not found.',
          HttpStatus.NOT_FOUND,
        );
      if (row.status === 'watching' || row.status === 'triggered') {
        const updated = await tx.futuresTpSlSetting.update({
          where: { id },
          data: {
            status: 'canceled',
            terminalReason: 'user_canceled',
            endedAt: await this.futures.dbNow(tx),
          },
          include: TP_SL_INCLUDE,
        });
        return this.single(accountId, updated, false);
      }
      // Executed, failed and canceled settings are terminal: replay.
      return this.single(accountId, row, true);
    });
  }

  async list(userId: string | undefined, accountId: string, query: ListQuery) {
    this.user(userId);
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const limit = Number(query.limit ?? 30),
      offset = Number(query.offset ?? 0);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      (query.state !== undefined && !['open', 'ended'].includes(query.state))
    )
      futuresError(
        'INVALID_PAGINATION',
        'Invalid pagination.',
        HttpStatus.BAD_REQUEST,
      );
    const where: Prisma.FuturesTpSlSettingWhereInput = {
      tradingAccountId: accountId,
      ...(query.positionId ? { positionId: query.positionId } : {}),
      ...(query.instrumentId ? { instrumentId: query.instrumentId } : {}),
      ...(query.state === 'ended' ? { NOT: liveFuturesTpSl } : liveFuturesTpSl),
    };
    const [rows, total, clock] = await Promise.all([
      this.prisma.futuresTpSlSetting.findMany({
        where,
        include: TP_SL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.futuresTpSlSetting.count({ where }),
      this.futures.dbNow(this.prisma),
    ]);
    const positions = await this.positions(accountId, rows);
    const enabled = futuresTpSlEnabled();
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        capabilities: {
          enabled,
          canCreate:
            enabled &&
            futuresTradingMode() !== 'DISABLED' &&
            conditionalTradable(account, clock),
          canCancel: true,
          maxLivePerAccount: FUTURES_TP_SL_MAX_LIVE_PER_ACCOUNT,
        },
        settings: rows.map((row) => presentFuturesTpSl(row, positions)),
        pagination: buildPagination({
          limit,
          offset,
          total,
          returned: rows.length,
        }),
      },
    };
  }

  /**
   * Worker step for one setting. Trigger evidence commits under the lifecycle
   * fence before any execution attempt; the attempt runs through the
   * existing Futures execution core, which re-locks and links the setting.
   */
  async evaluate(id: string): Promise<{ state: string }> {
    const target = await this.prisma.futuresTpSlSetting.findUnique({
      where: { id },
      select: {
        tradingAccountId: true,
        tradingAccount: { select: { userId: true } },
      },
    });
    if (!target) return { state: 'terminal' };
    const accountId = target.tradingAccountId,
      userId = target.tradingAccount.userId;
    const decision = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      await tx.$queryRaw`SELECT "id" FROM "futures_tp_sl_settings" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.futuresTpSlSetting.findUnique({
        where: { id },
        include: { instrument: { include: futuresInstrumentInclude } },
      });
      if (!row || (row.status !== 'watching' && row.status !== 'triggered'))
        return { state: 'terminal' };
      const now = await this.futures.dbNow(tx);
      const account = await this.access.getOwnedAccountOrThrow(
        userId,
        accountId,
        tx,
      );
      if (!conditionalTradable(account, now)) {
        await this.terminate(
          tx,
          id,
          'canceled',
          isStandaloneAccountMode(account.mode)
            ? 'account_not_tradable'
            : account.seasonParticipant?.participantStatus === 'excluded'
              ? 'participant_excluded'
              : 'season_ended',
          now,
        );
        return { state: 'lifecycle_canceled' };
      }
      // Safety net: the closing transaction already ended the setting; a
      // lifetime gone by other means ends it here.
      const position = await tx.futuresPosition.findFirst({
        where: { id: row.positionId, tradingAccountId: accountId },
        select: { status: true, quantity: true },
      });
      if (!position || position.status !== 'open' || position.quantity.lte(0)) {
        await this.terminate(tx, id, 'canceled', 'position_closed', now);
        return { state: 'position_closed' };
      }
      if (row.status === 'triggered') {
        if (
          !row.triggeredAt ||
          futuresTpSlWindowExpired(row.triggeredAt, now) ||
          row.attemptCount >= FUTURES_TP_SL_MAX_ATTEMPTS
        ) {
          await this.terminate(
            tx,
            id,
            'failed',
            'execution_window_expired',
            now,
            row.failureCode ?? 'FUTURES_TP_SL_EXECUTION_WINDOW_EXPIRED',
          );
          return { state: 'failed' };
        }
        return futuresTpSlEnabled()
          ? { state: 'execute' }
          : { state: 'disabled' };
      }
      if (!futuresTpSlEnabled()) return { state: 'disabled' };
      // Reduce-only exits run in ENABLED and REDUCE_ONLY; DISABLED pauses
      // user automation (risk liquidation stays independent).
      if (futuresTradingMode() === 'DISABLED') return { state: 'paused' };
      const price = await readFuturesLastPrice(tx, row.instrument, now, false);
      if (!price) return { state: 'price_unavailable' };
      // Only evidence of a trade received after registration may trigger.
      if (price.effectiveAt < row.createdAt || price.capturedAt < row.createdAt)
        return { state: 'awaiting_price' };
      if (
        !isFuturesTpSlMet(
          row.direction,
          row.kind,
          price.price,
          row.triggerPrice,
        )
      )
        return { state: 'watching' };
      await tx.futuresTpSlSetting.update({
        where: { id },
        data: {
          status: 'triggered',
          triggeredAt: now,
          triggerSnapshotId: price.id,
          triggerEvidenceJson: {
            instrumentId: row.instrumentId,
            symbol: price.symbol,
            positionId: row.positionId,
            direction: row.direction,
            kind: row.kind,
            triggerCondition: futuresTpSlCondition(row.direction, row.kind),
            triggerPrice: row.triggerPrice.toFixed(8),
            price: price.price.toFixed(8),
            currencyCode: price.currencyCode,
            priceBasis: 'futures_last',
            sourceName: price.source,
            effectiveAt: price.effectiveAt.toISOString(),
            capturedAt: price.capturedAt.toISOString(),
            snapshotId: price.id,
          },
        },
      });
      return { state: 'triggered' };
    });
    if (decision.state !== 'triggered' && decision.state !== 'execute')
      return decision;
    try {
      return { state: await this.execute(id, accountId, userId) };
    } catch (error) {
      const code = apiErrorCode(error, FUTURES_TP_SL_EXECUTION_FAILED);
      await this.recordAttemptFailure(id, accountId, userId, code);
      return { state: code };
    }
  }

  /** One attempt through the existing Futures core, keyed by the setting. */
  private async execute(id: string, accountId: string, userId: string) {
    const row = await this.prisma.futuresTpSlSetting.findFirst({
      where: { id, tradingAccountId: accountId, status: 'triggered' },
      include: { position: true },
    });
    if (!row) return 'terminal';
    // Sized NOW from the live lifetime; the execution transaction re-checks
    // the position under its own locks and a lost race is retried.
    const sizing = resolveFuturesTpSlExecution({
      target: row.quantity,
      positionQuantity: row.position.quantity,
    });
    if (row.position.status !== 'open' || !sizing)
      futuresError(
        'FUTURES_TP_SL_POSITION_UNAVAILABLE',
        'An open Futures position is required.',
      );
    await this.futures.execute(
      userId,
      accountId,
      {
        instrumentId: row.instrumentId,
        positionId: row.positionId,
        operation: sizing.operation,
        direction: row.position.direction,
        quantity: sizing.quantity.toFixed(8),
        leverage: row.position.leverage,
        marginMode: row.position.marginMode,
        idempotencyKey: `futures-tp-sl:${row.id}`,
      },
      undefined,
      undefined,
      undefined,
      row.id,
    );
    return 'ordered';
  }

  private async recordAttemptFailure(
    id: string,
    accountId: string,
    userId: string,
    code: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      await tx.$queryRaw`SELECT "id" FROM "futures_tp_sl_settings" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.futuresTpSlSetting.findUnique({ where: { id } });
      if (row?.status !== 'triggered' || !row.triggeredAt) return;
      const now = await this.futures.dbNow(tx);
      const attempts = row.attemptCount + 1;
      const windowExpired = code === 'FUTURES_TP_SL_EXECUTION_WINDOW_EXPIRED';
      const terminal =
        !isRetryableFuturesTpSlFailure(code) ||
        attempts >= FUTURES_TP_SL_MAX_ATTEMPTS ||
        futuresTpSlWindowExpired(row.triggeredAt, now);
      await tx.futuresTpSlSetting.update({
        where: { id },
        data: {
          attemptCount: attempts,
          lastAttemptAt: now,
          // A refusal past the window keeps an earlier attempt's root cause.
          failureCode: windowExpired ? (row.failureCode ?? code) : code,
          ...(terminal
            ? {
                status: 'failed',
                terminalReason: windowExpired
                  ? 'execution_window_expired'
                  : 'execution_failed',
                endedAt: now,
              }
            : {}),
        },
      });
    });
  }

  private async terminate(
    tx: Prisma.TransactionClient,
    id: string,
    status: 'canceled' | 'failed',
    reason:
      | FuturesTpSlLifecycleReason
      | 'position_closed'
      | 'execution_window_expired',
    now: Date,
    failureCode?: string,
  ) {
    await tx.futuresTpSlSetting.updateMany({
      where: { id, ...liveFuturesTpSl },
      data: {
        status,
        terminalReason: reason,
        endedAt: now,
        ...(failureCode ? { failureCode } : {}),
      },
    });
  }

  /** Current lifetime facts for live rows (display only, never money). */
  private async positions(
    accountId: string,
    rows: TpSlRecord[],
    client: Pick<Prisma.TransactionClient, 'futuresPosition'> = this.prisma,
  ) {
    const ids = [
      ...new Set(
        rows
          .filter(
            (row) => row.status === 'watching' || row.status === 'triggered',
          )
          .map((row) => row.positionId),
      ),
    ];
    if (!ids.length) return new Map<string, PositionFacts>();
    const positions = await client.futuresPosition.findMany({
      where: { tradingAccountId: accountId, id: { in: ids }, status: 'open' },
      select: { id: true, quantity: true },
    });
    return new Map(positions.map((row) => [row.id, row]));
  }

  private response(
    accountId: string,
    rows: TpSlRecord[],
    duplicate: boolean,
    positions: Map<string, PositionFacts>,
  ) {
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        settings: rows.map((row) => presentFuturesTpSl(row, positions)),
        duplicate,
      },
    };
  }

  private single(accountId: string, row: TpSlRecord, duplicate: boolean) {
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        setting: presentFuturesTpSl(row, new Map()),
        duplicate,
      },
    };
  }

  private user(userId: string | undefined): asserts userId is string {
    if (!userId)
      futuresError('UNAUTHORIZED', 'Unauthorized', HttpStatus.UNAUTHORIZED);
  }

  /** Existing financial writer fence (same as Futures limit entries). */
  private async lockAccount(
    tx: Prisma.TransactionClient,
    accountId: string,
    userId: string,
  ) {
    const account = await this.access.getOwnedAccountOrThrow(
      userId,
      accountId,
      tx,
    );
    if (isStandaloneAccountMode(account.mode))
      await tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${accountId} AND user_id = ${userId} FOR UPDATE`;
    else
      await lockSeasonTradingContext(tx, {
        seasonParticipantId: account.seasonParticipant!.id,
        userId,
        participantWrite: true,
      });
  }
}

/**
 * Setting state is distinct from the execution's: `filled` exists only when
 * the linked FuturesExecution committed. `quantity` is the user's target;
 * `execution.quantity` is what really reduced the position (it may be
 * smaller: the position had shrunk). `position` (live rows, when loaded) is
 * what a trigger now would execute — informational, the Futures core decides.
 */
export function presentFuturesTpSl(
  row: TpSlRecord,
  positions: Map<string, PositionFacts>,
) {
  const live = row.status === 'watching' || row.status === 'triggered';
  const position = live ? positions.get(row.positionId) : undefined;
  const sizing = position
    ? resolveFuturesTpSlExecution({
        target: row.quantity,
        positionQuantity: position.quantity,
      })
    : null;
  const execution = row.execution;
  return {
    id: row.id,
    tradingAccountId: row.tradingAccountId,
    instrumentId: row.instrumentId,
    instrument: presentFuturesInstrument(row.instrument),
    positionId: row.positionId,
    direction: row.direction,
    kind: row.kind,
    triggerCondition: futuresTpSlCondition(row.direction, row.kind),
    triggerPrice: row.triggerPrice.toFixed(8),
    quantity: row.quantity.toFixed(8),
    status: row.status,
    state: row.status === 'ordered' ? 'filled' : row.status,
    position: position
      ? {
          quantity: position.quantity.toFixed(8),
          executableQuantity: sizing?.quantity.toFixed(8) ?? null,
        }
      : null,
    execution: execution
      ? {
          executionId: execution.id,
          operation: execution.operation,
          executionPrice: execution.executionPrice.toFixed(8),
          quantity: execution.quantity.toFixed(8),
          feeAmount: execution.feeAmount.toFixed(8),
          realizedPnl: execution.realizedPnl.toFixed(8),
          positionQuantityAfter: execution.positionQuantityAfter.toFixed(8),
          executedAt: execution.executedAt.toISOString(),
        }
      : null,
    quantityLimited: !!execution && execution.quantity.lt(row.quantity),
    trigger: row.triggeredAt
      ? {
          triggeredAt: row.triggeredAt.toISOString(),
          snapshotId: row.triggerSnapshotId,
          evidence: row.triggerEvidenceJson,
        }
      : null,
    entryPlanId: row.entryPlan?.id ?? null,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    failureCode: row.failureCode,
    terminalReason: row.terminalReason,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
