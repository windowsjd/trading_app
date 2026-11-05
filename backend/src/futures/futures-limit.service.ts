import { assertBeginnerLearningAccess } from '../trading-accounts/beginner-learning-policy';
import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { buildPagination } from '../common/pagination';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, type FuturesLimitOrder } from '../generated/prisma/client';
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from '../trading-accounts/trading-account-access.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { isSeasonSuspended } from '../seasons/season-availability.policy';
import {
  releaseReservedCash,
  reserveAvailableCash,
} from '../wallets/cash-wallet-atomic';
import { createApiError } from '../common/api-error';
import {
  assertExpectedRevision,
  assertTermsChanged,
  evidenceFloor,
  isReplayedModification,
  modificationHash,
  notModifiable,
  parseModificationEnvelope,
  recordModification,
} from '../common/pending-order-modification';
import { createProtectionInTransaction } from '../conditional/conditional-registration';
import { parseEntryTpSlDrafts } from '../conditional/entry-tp-sl-policy';
import {
  assertEntryPlansFitChangedEntry,
  createEntryTpSlPlansInTransaction,
  resolveEntryRoot,
} from '../conditional/entry-tp-sl-state';
import { assertFuturesTpSlEnabled } from './futures-tp-sl-policy';
import {
  conditionalHash,
  conditionalTradable,
  parseProtectionLegs,
} from '../conditional/conditional-policy';

import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { FuturesService } from './futures.service';
import { futuresError } from './futures-error';
import { parseFuturesCommand } from './futures-input';
import { assertFuturesOperation, futuresTradingMode } from './futures.config';
import { verifiedFuturesInstrument } from './futures-instrument-coverage';
import {
  futuresDecimal,
  marginCeil,
  planFuturesExecution,
  assertFuturesMoney,
} from './futures-math';
import { accountFuturesFee } from './futures-risk';
import { assertFuturesTransferCollateral } from './futures-collateral';
import { readFuturesMark } from './futures-mark';
import { readFuturesLastPrice } from './futures-last-price';
import { cancelFuturesEntriesInTransaction } from './futures-limit-state';
import {
  assertFuturesConditionalEntryWindow,
  linkFuturesConditionalEntry,
  lockTriggeredFuturesConditionalEntry,
} from './futures-conditional-entry-state';
import {
  futuresInstrumentInclude,
  presentFuturesInstrument,
} from './futures.presenter';

export function parseFuturesEntry(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    futuresError('INVALID_FUTURES_REQUEST', 'Invalid Futures entry.', 400);
  const row = body as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (k) =>
        ![
          'instrumentId',
          'direction',
          'marginMode',
          'leverage',
          'quantity',
          'limitPrice',
          'idempotencyKey',
          'attachedProtection',
          'entryTpSl',
        ].includes(k),
    )
  )
    futuresError('INVALID_FUTURES_REQUEST', 'Invalid Futures entry.', 400);
  const { limitPrice, attachedProtection, entryTpSl, ...command } = row;
  if (attachedProtection !== undefined && entryTpSl !== undefined)
    futuresError('INVALID_FUTURES_REQUEST', 'Invalid Futures entry.', 400);
  const request = parseFuturesCommand({ ...command, operation: 'open' });
  if (
    typeof limitPrice !== 'string' ||
    !/^\d{1,16}(\.\d{1,8})?$/.test(limitPrice) ||
    futuresDecimal(limitPrice).lte(0)
  )
    futuresError(
      'INVALID_FUTURES_REQUEST',
      'Enter a positive limit price.',
      400,
    );
  return {
    ...request,
    limitPrice: futuresDecimal(limitPrice).toFixed(8),
    legs:
      attachedProtection === undefined
        ? []
        : parseProtectionLegs(attachedProtection),
    // Present only when sent, so legacy create hashes are unchanged.
    ...(entryTpSl === undefined
      ? {}
      : { entryTpSl: parseEntryTpSlDrafts(entryTpSl) }),
  };
}
/**
 * The new limit price and quantity of a change, read exactly as a
 * registration of the entry's own instrument, direction, margin mode and
 * leverage (no attachments: plans and OCO keep their own paths).
 */
export function parseFuturesEntryModify(
  body: unknown,
  row: Pick<
    FuturesLimitOrder,
    'instrumentId' | 'direction' | 'marginMode' | 'leverage'
  >,
  idempotencyKey: string,
) {
  const terms =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  return parseFuturesEntry({
    instrumentId: row.instrumentId,
    direction: row.direction,
    marginMode: row.marginMode,
    leverage: row.leverage,
    quantity: terms.quantity,
    limitPrice: terms.limitPrice,
    idempotencyKey,
  });
}

export function presentFuturesEntry(row: FuturesLimitOrder) {
  return {
    id: row.id,
    tradingAccountId: row.tradingAccountId,
    instrumentId: row.instrumentId,
    direction: row.direction,
    marginMode: row.marginMode,
    leverage: row.leverage,
    quantity: row.quantity.toFixed(8),
    limitPrice: row.limitPrice.toFixed(8),
    reservedAmount: row.reservedAmount.toFixed(8),
    status: row.status,
    executionId: row.executionId,
    terminalReason: row.terminalReason,
    createdAt: row.createdAt.toISOString(),
    // 설정 변경: the revision a change names, and when the terms last changed.
    revision: row.revision,
    revisedAt: row.revisedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class FuturesLimitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly futures: FuturesService,
  ) {}

  private async account(userId: string | undefined, accountId: string) {
    if (!userId) futuresError('UNAUTHORIZED', 'Unauthorized', 401);
    setAdminDiagnosticContext({
      domain: 'futures',
      operation: 'FUTURES_LIMIT_ENTRY',
      failureStage: 'futures_entry_ownership',
      entities: { tradingAccountId: accountId },
    });
    return this.access.getOwnedAccountOrThrow(userId, accountId);
  }
  private async lock(
    tx: Prisma.TransactionClient,
    account: OwnedTradingAccount,
    instrumentId?: string,
  ) {
    if (isStandaloneAccountMode(account.mode))
      await tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${account.id} FOR UPDATE`;
    else
      await lockSeasonTradingContext(tx, {
        userId: account.userId,
        seasonParticipantId: account.seasonParticipant!.id,
        participantWrite: true,
      });
    if (instrumentId)
      await tx.$queryRaw`SELECT i.id FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id WHERE i.id = ${instrumentId} FOR SHARE OF i, a`;
    await tx.$queryRaw`SELECT id FROM cash_wallets WHERE trading_account_id = ${account.id} AND wallet_scope = 'crypto_futures' AND currency_code = 'USD' FOR UPDATE`;
    return this.access.getOwnedAccountOrThrow(account.userId, account.id, tx);
  }
  async create(
    userId: string | undefined,
    accountId: string,
    body: unknown,
    conditionalEntryId?: string,
  ) {
    const account = await this.account(userId, accountId);
    const request = parseFuturesEntry(body);
    const requestHash = conditionalHash({ accountId, ...request });
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lock(tx, account, request.instrumentId);
      const replay = await tx.futuresLimitOrder.findUnique({
        where: {
          tradingAccountId_idempotencyKey: {
            tradingAccountId: accountId,
            idempotencyKey: request.idempotencyKey,
          },
        },
      });
      if (replay) {
        if (replay.requestHash !== requestHash)
          futuresError(
            'FUTURES_IDEMPOTENCY_CONFLICT',
            'This request conflicts with an earlier Futures command.',
          );
        return {
          success: true,
          data: {
            tradingAccountId: accountId,
            order: presentFuturesEntry(replay),
          },
        };
      }
      // A triggered Futures conditional entry (limit execution) is locked after
      // the existing fences and linked to the entry created below.
      const conditional = conditionalEntryId
        ? await lockTriggeredFuturesConditionalEntry(
            tx,
            conditionalEntryId,
            accountId,
            {
              executionType: 'limit',
              instrumentId: request.instrumentId,
              direction: request.direction,
              marginMode: request.marginMode ?? 'isolated',
              leverage: request.leverage,
              quantity: request.quantity,
              limitPrice: request.limitPrice,
            },
          )
        : null;
      assertFuturesOperation('open');
      const now = await this.futures.dbNow(tx);
      await this.futures.assertTradable(locked, now, tx);
      await assertBeginnerLearningAccess(tx, locked, 'allTrading');
      const instrument = await this.futures.instrument(
        tx,
        request.instrumentId,
      );
      if (!verifiedFuturesInstrument(instrument, now))
        futuresError(
          'FUTURES_INSTRUMENT_UNVERIFIED',
          'This Futures instrument is not yet available for new trades.',
        );
      if (
        (await tx.futuresPosition.findFirst({
          where: {
            tradingAccountId: accountId,
            instrumentId: instrument.id,
            status: 'open',
          },
        })) ||
        (await tx.futuresLimitOrder.findFirst({
          where: {
            tradingAccountId: accountId,
            instrumentId: instrument.id,
            status: 'submitted',
          },
        }))
      )
        futuresError(
          'FUTURES_ENTRY_PENDING',
          'Entry requires a flat position and no pending entry.',
        );
      setAdminDiagnosticContext({
        failureStage: 'futures_entry_mark_selection',
      });
      await readFuturesMark(tx, instrument, now);
      const wallet = await this.futures.wallet(tx, accountId);
      const plan = planFuturesExecution(
        request,
        null,
        futuresDecimal(request.limitPrice),
        await accountFuturesFee(tx, accountId),
      );
      const reservation = assertFuturesMoney(
        marginCeil(
          futuresDecimal(request.quantity)
            .mul(request.limitPrice)
            .div(request.leverage),
        ).add(plan.feeAmount),
      ).toFixed(8);
      setAdminDiagnosticContext({
        failureStage: 'futures_entry_collateral_reservation',
        evidence: {
          financialGuard: {
            guardName: 'futures_entry_reservation',
            walletScope: 'crypto_futures',
            currencyCode: 'USD',
            observation: 'mutation_plan',
            walletFound: true,
            scopeValid: true,
          },
        },
      });
      await assertFuturesTransferCollateral(tx, wallet, reservation);
      if (
        (await reserveAvailableCash(tx, {
          walletId: wallet.id,
          tradingAccountId: accountId,
          walletScope: 'crypto_futures',
          currencyCode: 'USD',
          amount: reservation,
        })) !== 1
      )
        futuresError(
          'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
          'Available Futures collateral is insufficient for margin and fees.',
        );
      const order = await tx.futuresLimitOrder.create({
        data: {
          tradingAccountId: accountId,
          instrumentId: instrument.id,
          direction: request.direction,
          marginMode: request.marginMode ?? 'isolated',
          leverage: request.leverage,
          quantity: request.quantity,
          limitPrice: request.limitPrice,
          reservedAmount: reservation,
          idempotencyKey: request.idempotencyKey,
          requestHash,
          createdAt: now,
        },
      });
      if (request.legs.length)
        await createProtectionInTransaction(tx, {
          accountId,
          domain: 'futures',
          assetId: instrument.underlyingAssetId,
          parentFuturesOrderId: order.id,
          legs: request.legs,
          now,
        });
      // The entry's stop-loss/take-profit plans, atomic with it: they
      // activate only on its fill, on the new lifetime.
      if (request.entryTpSl) {
        assertFuturesTpSlEnabled();
        const root = await resolveEntryRoot(
          tx,
          accountId,
          'futures_limit_order',
          order.id,
          true,
        );
        await createEntryTpSlPlansInTransaction(tx, {
          accountId,
          root: root!,
          intents: request.entryTpSl,
          idempotencyKey: (index) => `entry:${order.id}:${index}`,
          requestHash,
          now,
        });
      }
      if (conditional) {
        await assertFuturesConditionalEntryWindow(tx, conditional.triggeredAt);
        await linkFuturesConditionalEntry(
          tx,
          conditional.id,
          accountId,
          { limitOrderId: order.id },
          now,
        );
      }
      return {
        success: true,
        data: {
          tradingAccountId: accountId,
          order: presentFuturesEntry(order),
        },
      };
    });
  }
  async read(
    userId: string | undefined,
    accountId: string,
    query: { limit?: string; offset?: string } = {},
  ) {
    await this.account(userId, accountId);
    const limit = pageNumber(query.limit, 30, 1, 100);
    const offset = pageNumber(query.offset, 0, 0, 100000);
    const rows = await this.prisma.futuresLimitOrder.findMany({
      where: { tradingAccountId: accountId, status: 'submitted' },
      include: { instrument: { include: futuresInstrumentInclude } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    });
    const total = await this.prisma.futuresLimitOrder.count({
      where: { tradingAccountId: accountId, status: 'submitted' },
    });
    return {
      success: true,
      data: {
        tradingAccountId: accountId,
        pagination: buildPagination({
          limit,
          offset,
          total,
          returned: rows.length,
        }),
        orders: rows.map((row) => ({
          ...presentFuturesEntry(row),
          instrument: presentFuturesInstrument(row.instrument),
        })),
        limit,
        offset,
      },
    };
  }
  /**
   * 설정 변경 (docs/pending-order-modification-contract.md) of a submitted
   * entry's limit price and quantity, in place. Same fences as create and
   * execution (account → instrument → the Futures wallet), so a concurrent
   * fill or cancel either committed first (the change is refused) or sees the
   * new terms. The reservation is derived exactly as at registration (margin
   * at the limit price and leverage, plus the fee plan) and moves by the
   * difference; a shortage of free collateral refuses the whole change.
   * Direction, margin mode and leverage stay. An entry a conditional entry
   * created, or one under a live OCO, keeps its own path (cancel).
   */
  async modify(
    userId: string | undefined,
    accountId: string,
    orderId: string,
    body: unknown,
  ) {
    const account = await this.account(userId, accountId);
    const envelope = parseModificationEnvelope(body);
    return this.prisma.$transaction(async (tx) => {
      const located = await tx.futuresLimitOrder.findFirst({
        where: { id: orderId, tradingAccountId: accountId },
        select: { instrumentId: true },
      });
      if (!located)
        futuresError('FUTURES_ENTRY_NOT_FOUND', 'Entry was not found.', 404);
      const locked = await this.lock(tx, account, located.instrumentId);
      await tx.$queryRaw`SELECT "id" FROM "futures_limit_orders" WHERE "id" = ${orderId} AND "trading_account_id" = ${accountId} FOR UPDATE`;
      const row = await tx.futuresLimitOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: {
          conditionalEntry: { select: { id: true } },
          protection: { select: { status: true } },
        },
      });
      const request = parseFuturesEntryModify(
        body,
        row,
        envelope.idempotencyKey,
      );
      const terms = {
        limitPrice: futuresDecimal(request.limitPrice).toFixed(8),
        quantity: futuresDecimal(request.quantity).toFixed(8),
      };
      const requestHash = modificationHash(
        'futures_limit_order',
        orderId,
        envelope.expectedRevision,
        terms,
      );
      const present = (order: FuturesLimitOrder, duplicate: boolean) => ({
        success: true,
        data: {
          tradingAccountId: accountId,
          order: presentFuturesEntry(order),
          duplicate,
        },
      });
      if (
        await isReplayedModification(tx, {
          accountId,
          target: 'futures_limit_order',
          targetId: orderId,
          idempotencyKey: envelope.idempotencyKey,
          requestHash,
        })
      )
        return present(row, true);
      if (row.status !== 'submitted') notModifiable();
      if (row.conditionalEntry)
        throw createApiError(
          'PENDING_ORDER_CHILD_NOT_MODIFIABLE',
          'An order placed by a condition or another setting cannot be changed; cancel it instead.',
          409,
        );
      if (
        row.protection &&
        (row.protection.status === 'holding' ||
          row.protection.status === 'active')
      )
        throw createApiError(
          'PENDING_ORDER_PROTECTION_NOT_MODIFIABLE',
          'Orders protected by an existing TP/SL (OCO) cannot be changed; cancel the protection first.',
          409,
        );
      assertExpectedRevision(row.revision, envelope.expectedRevision);
      const before = {
        limitPrice: row.limitPrice.toFixed(8),
        quantity: row.quantity.toFixed(8),
      };
      assertTermsChanged(before, terms);
      assertFuturesOperation('open');
      const now = await this.futures.dbNow(tx);
      await this.futures.assertTradable(locked, now, tx);
      await assertBeginnerLearningAccess(tx, locked, 'allTrading');
      const instrument = await this.futures.instrument(tx, row.instrumentId);
      if (!verifiedFuturesInstrument(instrument, now))
        futuresError(
          'FUTURES_INSTRUMENT_UNVERIFIED',
          'This Futures instrument is not yet available for new trades.',
        );
      if (
        await tx.futuresPosition.findFirst({
          where: {
            tradingAccountId: accountId,
            instrumentId: instrument.id,
            status: 'open',
          },
        })
      )
        futuresError(
          'FUTURES_ENTRY_PENDING',
          'Entry requires a flat position and no pending entry.',
        );
      await assertEntryPlansFitChangedEntry(
        tx,
        { futuresLimitOrderId: orderId },
        row.direction,
        futuresDecimal(request.limitPrice),
      );
      setAdminDiagnosticContext({
        failureStage: 'futures_entry_mark_selection',
      });
      await readFuturesMark(tx, instrument, now);
      const wallet = await this.futures.wallet(tx, accountId);
      const plan = planFuturesExecution(
        request,
        null,
        futuresDecimal(request.limitPrice),
        await accountFuturesFee(tx, accountId),
      );
      const reservation = assertFuturesMoney(
        marginCeil(
          futuresDecimal(request.quantity)
            .mul(request.limitPrice)
            .div(request.leverage),
        ).add(plan.feeAmount),
      );
      const delta = reservation.sub(row.reservedAmount);
      const target = {
        walletId: wallet.id,
        tradingAccountId: accountId,
        walletScope: 'crypto_futures' as const,
        currencyCode: 'USD' as const,
        amount: delta.abs().toFixed(8),
      };
      if (delta.gt(0)) {
        await assertFuturesTransferCollateral(tx, wallet, target.amount);
        if ((await reserveAvailableCash(tx, target)) !== 1)
          futuresError(
            'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
            'Available Futures collateral is insufficient for margin and fees.',
          );
      } else if (delta.lt(0) && (await releaseReservedCash(tx, target)) !== 1)
        futuresError(
          'FINANCIAL_SCOPE_REPAIR_REQUIRED',
          'Futures wallet information could not be verified.',
          500,
        );
      const updated = await tx.futuresLimitOrder.update({
        where: { id: orderId },
        data: {
          limitPrice: terms.limitPrice,
          quantity: terms.quantity,
          reservedAmount: reservation.toFixed(8),
          revisedAt: now,
          revision: { increment: 1 },
        },
      });
      await recordModification(tx, {
        accountId,
        target: 'futures_limit_order',
        targetId: orderId,
        idempotencyKey: envelope.idempotencyKey,
        requestHash,
        revision: updated.revision,
        before: { ...before, reservedAmount: row.reservedAmount.toFixed(8) },
        after: { ...terms, reservedAmount: updated.reservedAmount.toFixed(8) },
        at: now,
      });
      return present(updated, false);
    });
  }
  async cancel(userId: string | undefined, accountId: string, orderId: string) {
    const account = await this.account(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, account);
      const row = await tx.futuresLimitOrder.findFirst({
        where: { id: orderId, tradingAccountId: accountId },
      });
      if (!row)
        futuresError('FUTURES_ENTRY_NOT_FOUND', 'Entry was not found.', 404);
      await cancelFuturesEntriesInTransaction(
        tx,
        accountId,
        'user_canceled',
        await this.futures.dbNow(tx),
        orderId,
      );
      const result = await tx.futuresLimitOrder.findUniqueOrThrow({
        where: { id: orderId },
      });
      return {
        success: true,
        data: {
          tradingAccountId: accountId,
          order: presentFuturesEntry(result),
        },
      };
    });
  }
  async evaluate(orderId: string) {
    const row = await this.prisma.futuresLimitOrder.findUnique({
      where: { id: orderId },
      include: { tradingAccount: true },
    });
    if (!row || row.status !== 'submitted') return { state: 'terminal' };
    const account = await this.access.getOwnedAccountOrThrow(
      row.tradingAccount.userId,
      row.tradingAccountId,
    );
    const evaluationAt = await this.futures.dbNow(this.prisma);
    const tradable = conditionalTradable(account, evaluationAt);
    if (tradable && futuresTradingMode() === 'ENABLED') {
      const instrument = await this.futures.instrument(
        this.prisma,
        row.instrumentId,
      );
      const price = (await readFuturesLastPrice(
        this.prisma,
        instrument,
        evaluationAt,
      ))!;
      // Negative preview only, on the same Futures Last basis. Candidate
      // executions select evidence and check the predicate again under locks.
      const floor = evidenceFloor(row, row.createdAt);
      if (
        price.effectiveAt < floor ||
        price.capturedAt < floor ||
        (row.direction === 'long'
          ? price.price.gt(row.limitPrice)
          : price.price.lt(row.limitPrice))
      )
        futuresError(
          'FUTURES_ENTRY_LIMIT_NOT_REACHED',
          'The entry limit is not executable.',
        );
    }
    // Every candidate retains the original lifecycle cleanup fence, including
    // a Season ending while the matcher waits for that fence.
    const ended = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lock(tx, account);
      const now = await this.futures.dbNow(tx);
      if (
        locked.mode === 'season' &&
        locked.seasonParticipant &&
        isSeasonSuspended(locked.seasonParticipant.season, now)
      )
        return 'paused' as const;
      if (conditionalTradable(locked, now)) return false;
      const reason = isStandaloneAccountMode(locked.mode)
        ? 'account_not_tradable'
        : locked.seasonParticipant?.participantStatus === 'excluded'
          ? 'participant_excluded'
          : 'season_ended';
      await cancelFuturesEntriesInTransaction(
        tx,
        account.id,
        reason,
        now,
        row.id,
      );
      return true;
    });
    if (ended === 'paused') return { state: 'paused' };
    if (ended) return { state: 'canceled' };
    if (futuresTradingMode() !== 'ENABLED') return { state: 'paused' };
    await this.futures.execute(
      account.userId,
      account.id,
      {
        instrumentId: row.instrumentId,
        operation: 'open',
        direction: row.direction,
        marginMode: row.marginMode,
        leverage: row.leverage,
        quantity: row.quantity.toFixed(8),
        idempotencyKey: row.id,
      },
      undefined,
      row.id,
    );
    return { state: 'executed' };
  }
}

function pageNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    futuresError('INVALID_PAGINATION', 'Invalid pagination.', 400);
  return Number(value);
}
