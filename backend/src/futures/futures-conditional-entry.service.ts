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
import { endEntryTpSlPlansOfEndedEntries } from '../conditional/entry-tp-sl-state';
import { futuresError } from './futures-error';
import {
  assertFuturesOperation,
  futuresConditionalEntryEnabled,
  futuresTradingMode,
} from './futures.config';
import { verifiedFuturesInstrument } from './futures-instrument-coverage';
import { readFuturesLastPrice } from './futures-last-price';
import { FuturesService } from './futures.service';
import { FuturesLimitService } from './futures-limit.service';
import {
  futuresInstrumentInclude,
  presentFuturesInstrument,
} from './futures.presenter';
import {
  assertFuturesConditionalEntryEnabled,
  FUTURES_CONDITIONAL_ENTRY_EXECUTION_FAILED,
  FUTURES_CONDITIONAL_ENTRY_MAX_ATTEMPTS,
  FUTURES_CONDITIONAL_ENTRY_MAX_LIVE_PER_ACCOUNT,
  futuresConditionalEntryCommandKey,
  futuresConditionalEntryHash,
  futuresConditionalEntryWindowExpired,
  isFuturesConditionalEntryMet,
  isRetryableFuturesConditionalEntryFailure,
  parseFuturesConditionalEntryBody,
} from './futures-conditional-entry-policy';
import {
  liveFuturesConditionalEntry,
  openFuturesConditionalEntry,
  type FuturesConditionalEntryLifecycleReason,
} from './futures-conditional-entry-state';

const ENTRY_INCLUDE = {
  instrument: { include: futuresInstrumentInclude },
  execution: {
    select: {
      id: true,
      positionId: true,
      executionPrice: true,
      quantity: true,
      feeAmount: true,
      executedAt: true,
    },
  },
  limitOrder: {
    select: {
      id: true,
      status: true,
      limitPrice: true,
      reservedAmount: true,
      executionId: true,
      terminalReason: true,
      createdAt: true,
      endedAt: true,
    },
  },
} as const;

type EntryRecord = Prisma.FuturesConditionalEntryGetPayload<{
  include: typeof ENTRY_INCLUDE;
}>;

type ListQuery = {
  limit?: string;
  offset?: string;
  state?: string;
  instrumentId?: string;
};

/**
 * Futures Conditional Entry v1: a reservation-free watch on the contract's
 * verified Futures Last that, once its trigger is recorded, creates ONE new
 * position through the existing Futures services — a market `open` or a
 * Futures limit entry. Lifecycle authorization uses the existing Season →
 * Account → Participant / General Account fence; the created execution or
 * limit entry is settled entirely by the existing cores.
 */
@Injectable()
export class FuturesConditionalEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly futures: FuturesService,
    private readonly limits: FuturesLimitService,
  ) {}

  async create(userId: string | undefined, accountId: string, body: unknown) {
    this.user(userId);
    const input = parseFuturesConditionalEntryBody(body);
    const hash = futuresConditionalEntryHash(accountId, input);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      const committed = await tx.futuresConditionalEntry.findUnique({
        where: {
          tradingAccountId_idempotencyKey: {
            tradingAccountId: accountId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: ENTRY_INCLUDE,
      });
      if (committed) {
        if (committed.requestHash !== hash)
          futuresError(
            'FUTURES_IDEMPOTENCY_CONFLICT',
            'This request conflicts with an earlier Futures command.',
          );
        return this.response(accountId, committed, true);
      }
      assertFuturesConditionalEntryEnabled();
      assertFuturesOperation('open');
      const now = await this.futures.dbNow(tx);
      const account = await this.access.getOwnedAccountOrThrow(
        userId,
        accountId,
        tx,
      );
      await this.futures.assertTradable(account, now, tx);
      await assertBeginnerLearningAccess(tx, account, 'allTrading');
      const instrument = await this.futures.instrument(tx, input.instrumentId);
      if (!verifiedFuturesInstrument(instrument, now))
        futuresError(
          'FUTURES_INSTRUMENT_UNVERIFIED',
          'This Futures instrument is not yet available for new trades.',
        );
      const scope = {
        tradingAccountId: accountId,
        instrumentId: instrument.id,
      };
      // The current one-way position policy: a new position needs a flat
      // instrument with no pending limit entry or other live watch.
      if (
        await tx.futuresPosition.findFirst({
          where: { ...scope, status: 'open' },
        })
      )
        futuresError(
          'FUTURES_POSITION_ALREADY_OPEN',
          'Close the existing one-way position before registering a new entry.',
        );
      if (
        await tx.futuresLimitOrder.findFirst({
          where: { ...scope, status: 'submitted' },
        })
      )
        futuresError(
          'FUTURES_ENTRY_PENDING',
          'Cancel the pending entry before registering a conditional entry.',
        );
      if (
        await tx.futuresConditionalEntry.findFirst({
          where: { ...scope, ...liveFuturesConditionalEntry },
        })
      )
        futuresError(
          'FUTURES_CONDITIONAL_ENTRY_PENDING',
          'This instrument already has a live conditional entry.',
        );
      const live = await tx.futuresConditionalEntry.count({
        where: { tradingAccountId: accountId, ...liveFuturesConditionalEntry },
      });
      if (live >= FUTURES_CONDITIONAL_ENTRY_MAX_LIVE_PER_ACCOUNT)
        futuresError(
          'FUTURES_CONDITIONAL_ENTRY_LIMIT_EXCEEDED',
          'Too many live Futures conditional entries.',
        );
      setAdminDiagnosticContext({
        domain: 'futures',
        operation: 'FUTURES_CONDITIONAL_ENTRY_CREATE',
        failureStage: 'futures_conditional_entry_price_selection',
        entities: { tradingAccountId: accountId, instrumentId: instrument.id },
      });
      const price = (await readFuturesLastPrice(tx, instrument, now))!;
      if (
        isFuturesConditionalEntryMet(
          input.triggerCondition,
          price.price,
          input.triggerPrice,
        )
      )
        futuresError(
          'FUTURES_CONDITIONAL_ENTRY_ALREADY_MET',
          'The current Futures Last already meets this condition.',
        );
      const row = await tx.futuresConditionalEntry.create({
        data: {
          tradingAccountId: accountId,
          instrumentId: instrument.id,
          direction: input.direction,
          marginMode: input.marginMode,
          leverage: input.leverage,
          quantity: input.quantity,
          triggerCondition: input.triggerCondition,
          triggerPrice: input.triggerPrice,
          executionType: input.executionType,
          limitPrice: input.limitPrice,
          registrationSnapshotId: price.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          createdAt: now,
        },
        include: ENTRY_INCLUDE,
      });
      if (!conditionalTradable(account, await this.futures.dbNow(tx)))
        futuresError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
        );
      return this.response(accountId, row, false);
    });
  }

  async cancel(userId: string | undefined, accountId: string, id: string) {
    this.user(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      await tx.$queryRaw`SELECT "id" FROM "futures_conditional_entries" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
      const row = await tx.futuresConditionalEntry.findFirst({
        where: { id, tradingAccountId: accountId },
        include: ENTRY_INCLUDE,
      });
      if (!row)
        futuresError(
          'FUTURES_CONDITIONAL_ENTRY_NOT_FOUND',
          'Conditional entry not found.',
          HttpStatus.NOT_FOUND,
        );
      if (row.status === 'ordered')
        futuresError(
          'FUTURES_CONDITIONAL_ENTRY_ALREADY_ORDERED',
          'The entry order was already created; manage the limit entry or position instead.',
        );
      if (row.status === 'watching' || row.status === 'triggered') {
        const now = await this.futures.dbNow(tx);
        const updated = await tx.futuresConditionalEntry.update({
          where: { id },
          data: {
            status: 'canceled',
            terminalReason: 'user_canceled',
            endedAt: now,
          },
          include: ENTRY_INCLUDE,
        });
        await endEntryTpSlPlansOfEndedEntries(tx, accountId, now);
        return this.response(accountId, updated, false);
      }
      return this.response(accountId, row, true);
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
    const where: Prisma.FuturesConditionalEntryWhereInput = {
      tradingAccountId: accountId,
      ...(query.instrumentId ? { instrumentId: query.instrumentId } : {}),
      ...(query.state === 'ended'
        ? { NOT: openFuturesConditionalEntry }
        : openFuturesConditionalEntry),
    };
    const [rows, total, clock] = await Promise.all([
      this.prisma.futuresConditionalEntry.findMany({
        where,
        include: ENTRY_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.futuresConditionalEntry.count({ where }),
      this.futures.dbNow(this.prisma),
    ]);
    const enabled = futuresConditionalEntryEnabled();
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        capabilities: {
          enabled,
          canCreate:
            enabled &&
            futuresTradingMode() === 'ENABLED' &&
            conditionalTradable(account, clock),
          maxLivePerAccount: FUTURES_CONDITIONAL_ENTRY_MAX_LIVE_PER_ACCOUNT,
        },
        entries: rows.map((row) => presentFuturesConditionalEntry(row)),
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
   * Worker step for one watch. Trigger evidence commits under the lifecycle
   * fence before any order attempt; the attempt runs through the existing
   * Futures execution / limit-entry core, which re-locks and links the watch.
   */
  async evaluate(id: string): Promise<{ state: string }> {
    const target = await this.prisma.futuresConditionalEntry.findUnique({
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
      await tx.$queryRaw`SELECT "id" FROM "futures_conditional_entries" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.futuresConditionalEntry.findUnique({
        where: { id },
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
      const instrument = await tx.futuresInstrument.findUnique({
        where: { id: row.instrumentId },
        include: futuresInstrumentInclude,
      });
      if (!instrument?.isActive || !instrument.underlyingAsset.isActive) {
        await this.terminate(
          tx,
          id,
          'canceled',
          'instrument_not_tradable',
          now,
        );
        return { state: 'lifecycle_canceled' };
      }
      if (row.status === 'triggered') {
        if (
          !row.triggeredAt ||
          futuresConditionalEntryWindowExpired(row.triggeredAt, now) ||
          row.attemptCount >= FUTURES_CONDITIONAL_ENTRY_MAX_ATTEMPTS
        ) {
          await this.terminate(
            tx,
            id,
            'failed',
            'execution_window_expired',
            now,
            row.failureCode ??
              'FUTURES_CONDITIONAL_ENTRY_EXECUTION_WINDOW_EXPIRED',
          );
          return { state: 'failed' };
        }
        return futuresConditionalEntryEnabled()
          ? { state: 'execute' }
          : { state: 'disabled' };
      }
      if (!futuresConditionalEntryEnabled()) return { state: 'disabled' };
      // Like Futures limit entries, watches pause outside ENABLED mode.
      if (futuresTradingMode() !== 'ENABLED') return { state: 'paused' };
      const price = await readFuturesLastPrice(tx, instrument, now, false);
      if (!price) return { state: 'price_unavailable' };
      // Only evidence of a trade received after registration may trigger.
      if (price.effectiveAt < row.createdAt || price.capturedAt < row.createdAt)
        return { state: 'awaiting_price' };
      if (
        !isFuturesConditionalEntryMet(
          row.triggerCondition,
          price.price,
          row.triggerPrice,
        )
      )
        return { state: 'watching' };
      await tx.futuresConditionalEntry.update({
        where: { id },
        data: {
          status: 'triggered',
          triggeredAt: now,
          triggerSnapshotId: price.id,
          triggerEvidenceJson: {
            instrumentId: row.instrumentId,
            symbol: price.symbol,
            triggerCondition: row.triggerCondition,
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
      const code = apiErrorCode(
        error,
        FUTURES_CONDITIONAL_ENTRY_EXECUTION_FAILED,
      );
      await this.recordAttemptFailure(id, accountId, userId, code);
      return { state: code };
    }
  }

  /** One attempt through the existing Futures core, keyed by the entry. */
  private async execute(id: string, accountId: string, userId: string) {
    const row = await this.prisma.futuresConditionalEntry.findFirst({
      where: { id, tradingAccountId: accountId, status: 'triggered' },
    });
    if (!row) return 'terminal';
    const intent = {
      instrumentId: row.instrumentId,
      direction: row.direction,
      marginMode: row.marginMode,
      leverage: row.leverage,
      quantity: row.quantity.toFixed(8),
      idempotencyKey: futuresConditionalEntryCommandKey(row.id),
    };
    if (row.executionType === 'market')
      await this.futures.execute(
        userId,
        accountId,
        { ...intent, operation: 'open' },
        undefined,
        undefined,
        row.id,
      );
    else
      await this.limits.create(
        userId,
        accountId,
        { ...intent, limitPrice: row.limitPrice!.toFixed(8) },
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
      await tx.$queryRaw`SELECT "id" FROM "futures_conditional_entries" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.futuresConditionalEntry.findUnique({
        where: { id },
      });
      if (row?.status !== 'triggered' || !row.triggeredAt) return;
      const now = await this.futures.dbNow(tx);
      const attempts = row.attemptCount + 1;
      const windowExpired =
        code === 'FUTURES_CONDITIONAL_ENTRY_EXECUTION_WINDOW_EXPIRED';
      const terminal =
        !isRetryableFuturesConditionalEntryFailure(code) ||
        attempts >= FUTURES_CONDITIONAL_ENTRY_MAX_ATTEMPTS ||
        futuresConditionalEntryWindowExpired(row.triggeredAt, now);
      await tx.futuresConditionalEntry.update({
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
      if (terminal) await endEntryTpSlPlansOfEndedEntries(tx, accountId, now);
    });
  }

  private async terminate(
    tx: Prisma.TransactionClient,
    id: string,
    status: 'canceled' | 'failed',
    reason: FuturesConditionalEntryLifecycleReason | 'execution_window_expired',
    now: Date,
    failureCode?: string,
  ) {
    const ended = await tx.futuresConditionalEntry.updateMany({
      where: { id, ...liveFuturesConditionalEntry },
      data: {
        status,
        terminalReason: reason,
        endedAt: now,
        ...(failureCode ? { failureCode } : {}),
      },
    });
    if (ended.count) {
      const row = await tx.futuresConditionalEntry.findUniqueOrThrow({
        where: { id },
        select: { tradingAccountId: true },
      });
      await endEntryTpSlPlansOfEndedEntries(tx, row.tradingAccountId, now);
    }
  }

  private response(accountId: string, row: EntryRecord, duplicate: boolean) {
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        entry: presentFuturesConditionalEntry(row),
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

/** Watch state is distinct from the created order's execution state. */
export function presentFuturesConditionalEntry(row: EntryRecord) {
  const limitOrder = row.limitOrder;
  const execution = row.execution;
  return {
    id: row.id,
    tradingAccountId: row.tradingAccountId,
    instrumentId: row.instrumentId,
    instrument: presentFuturesInstrument(row.instrument),
    direction: row.direction,
    marginMode: row.marginMode,
    leverage: row.leverage,
    quantity: row.quantity.toFixed(8),
    triggerCondition: row.triggerCondition,
    triggerPrice: row.triggerPrice.toFixed(8),
    executionType: row.executionType,
    limitPrice: row.limitPrice?.toFixed(8) ?? null,
    status: row.status,
    state:
      row.status !== 'ordered'
        ? row.status
        : execution
          ? 'filled'
          : limitOrder?.status === 'executed'
            ? 'filled'
            : limitOrder?.status === 'submitted'
              ? 'order_pending'
              : limitOrder?.status === 'canceled'
                ? 'order_canceled'
                : 'order_rejected',
    trigger: row.triggeredAt
      ? {
          triggeredAt: row.triggeredAt.toISOString(),
          snapshotId: row.triggerSnapshotId,
          evidence: row.triggerEvidenceJson,
        }
      : null,
    execution: execution
      ? {
          executionId: execution.id,
          positionId: execution.positionId,
          executionPrice: execution.executionPrice.toFixed(8),
          quantity: execution.quantity.toFixed(8),
          feeAmount: execution.feeAmount.toFixed(8),
          executedAt: execution.executedAt.toISOString(),
        }
      : null,
    limitOrder: limitOrder
      ? {
          orderId: limitOrder.id,
          status: limitOrder.status,
          limitPrice: limitOrder.limitPrice.toFixed(8),
          reservedAmount: limitOrder.reservedAmount.toFixed(8),
          executionId: limitOrder.executionId,
          terminalReason: limitOrder.terminalReason,
          createdAt: limitOrder.createdAt.toISOString(),
          endedAt: limitOrder.endedAt?.toISOString() ?? null,
        }
      : null,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    failureCode: row.failureCode,
    terminalReason: row.terminalReason,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
