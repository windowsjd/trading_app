import { buildPagination } from '../common/pagination';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, type FuturesLimitOrder } from '../generated/prisma/client';
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from '../trading-accounts/trading-account-access.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { reserveAvailableCash } from '../wallets/cash-wallet-atomic';
import { createProtectionInTransaction } from '../conditional/conditional-registration';
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
import { cancelFuturesEntriesInTransaction } from './futures-limit-state';
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
        ].includes(k),
    )
  )
    futuresError('INVALID_FUTURES_REQUEST', 'Invalid Futures entry.', 400);
  const { limitPrice, attachedProtection, ...command } = row;
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
  };
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
    if (account.mode === 'general')
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
  async create(userId: string | undefined, accountId: string, body: unknown) {
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
      assertFuturesOperation('open');
      const now = await this.futures.dbNow(tx);
      await this.futures.assertTradable(locked, now, tx);
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
    const ended = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lock(tx, account);
      const now = await this.futures.dbNow(tx);
      if (conditionalTradable(locked, now)) return false;
      const reason =
        locked.mode === 'general'
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
