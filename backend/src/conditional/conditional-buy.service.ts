import { Injectable } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { apiErrorCode } from '../common/api-error-code';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import { buildPagination } from '../common/pagination';
import { formatDecimalScale, monetaryScale } from '../fx/fx-decimal-policy';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isFuturesOnlyAsset } from '../providers/binance/binance-product-catalog';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { assertBeginnerLearningAccess } from '../trading-accounts/beginner-learning-policy';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { OrdersService } from '../orders/orders.service';
import { assertOrderInputPolicy } from '../orders/order-input-policy';
import { isLimitOrderEnabled } from '../orders/limit-order.config';
import { readLimitOrderMatchingConfig } from '../orders/limit-order-matching.config';
import { conditionalTradable } from './conditional-policy';
import { conditionalPrice } from './conditional-price';
import {
  assertConditionalBuyEnabled,
  CONDITIONAL_BUY_MAX_ATTEMPTS,
  CONDITIONAL_BUY_MAX_LIVE_PER_ACCOUNT,
  conditionalBuyEnabled,
  conditionalBuyHash,
  conditionalBuyWindowExpired,
  isConditionalBuyMet,
  isRetryableConditionalBuyFailure,
  parseConditionalBuyBody,
  type ConditionalBuyBody,
} from './conditional-buy-policy';
import {
  liveConditionalBuy,
  openConditionalBuy,
} from './conditional-buy-state';

const CONDITIONAL_BUY_INCLUDE = {
  asset: {
    select: {
      id: true,
      symbol: true,
      name: true,
      market: true,
      assetType: true,
    },
  },
  order: {
    select: {
      id: true,
      orderType: true,
      status: true,
      quantity: true,
      executedQuantity: true,
      limitPrice: true,
      executedPrice: true,
      grossAmount: true,
      feeAmount: true,
      netAmount: true,
      reservedAmount: true,
      cancelReason: true,
      assetPriceSnapshotId: true,
      limitOrderCandleEvidenceId: true,
      submittedAt: true,
      executedAt: true,
      canceledAt: true,
    },
  },
} as const;

type ConditionalBuyRecord = Prisma.ConditionalBuyOrderGetPayload<{
  include: typeof CONDITIONAL_BUY_INCLUDE;
}>;

type ConditionalBuyListQuery = {
  limit?: string;
  offset?: string;
  assetId?: string;
  history?: string;
  /** `open` | `ended`; not combined with `history`. */
  state?: string;
};

/**
 * Conditional BUY: a reservation-free price watch on KRX stocks and Spot
 * crypto that, once its eligible trigger is recorded, submits ONE ordinary
 * market or limit BUY through OrdersService. Lifecycle authorization uses
 * the existing Season → Account → Participant / General Account fence; the
 * created Order is settled entirely by existing cores (market execute or
 * the limit matcher).
 */
@Injectable()
export class ConditionalBuyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly orders: OrdersService,
  ) {}

  async create(
    userId: string | undefined,
    accountId: string,
    body: ConditionalBuyBody,
  ) {
    this.user(userId);
    const input = parseConditionalBuyBody(body);
    const hash = conditionalBuyHash(input);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      const committed = await tx.conditionalBuyOrder.findUnique({
        where: {
          tradingAccountId_idempotencyKey: {
            tradingAccountId: accountId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: CONDITIONAL_BUY_INCLUDE,
      });
      if (committed) {
        if (committed.requestHash !== hash)
          throw createApiError(
            'CONDITIONAL_IDEMPOTENCY_CONFLICT',
            'The command differs from the committed request.',
            409,
          );
        return this.response(accountId, committed, true);
      }
      assertConditionalBuyEnabled();
      if (
        input.executionType === 'limit' &&
        (!isLimitOrderEnabled() ||
          !readLimitOrderMatchingConfig().matchingEnabled)
      )
        throw createApiError(
          'CONDITIONAL_LIMIT_UNAVAILABLE',
          'Spot Limit registration and matching must be available.',
          409,
        );
      const now = await this.now(tx);
      const account = await this.access.getOwnedAccountOrThrow(
        userId,
        accountId,
        tx,
      );
      if (!conditionalTradable(account, now))
        throw createApiError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
          409,
        );
      const asset = await tx.asset.findUnique({
        where: { id: input.assetId },
      });
      if (!asset)
        throw createApiError('ASSET_NOT_FOUND', 'Asset not found.', 404);
      if (!asset.isActive || isFuturesOnlyAsset(asset))
        throw createApiError(
          'ASSET_NOT_TRADABLE',
          'Asset is not a Spot product.',
          400,
        );
      if (asset.assetType === 'us_stock')
        throw createApiError(
          'CONDITIONAL_BUY_MARKET_NOT_SUPPORTED',
          'Conditional buy orders are available for Korean stocks and crypto.',
          409,
        );
      if (input.currencyCode && input.currencyCode !== asset.settlementCurrency)
        throw createApiError(
          'ASSET_CURRENCY_MISMATCH',
          'currencyCode must match asset settlementCurrency.',
          400,
        );
      assertOrderInputPolicy({
        assetType: asset.assetType,
        side: 'buy',
        orderType: input.executionType,
        quantity: input.quantity,
        amount: input.amount,
      });
      await assertBeginnerLearningAccess(tx, account, 'allTrading');
      const live = await tx.conditionalBuyOrder.count({
        where: { tradingAccountId: accountId, ...liveConditionalBuy },
      });
      if (live >= CONDITIONAL_BUY_MAX_LIVE_PER_ACCOUNT)
        throw createApiError(
          'CONDITIONAL_BUY_LIMIT_EXCEEDED',
          'Too many active conditional buy orders.',
          409,
        );
      const price = await conditionalPrice(tx, asset, 'spot', now);
      if (!price) {
        setAdminDiagnosticContext({
          domain: 'CONDITIONAL',
          operation: 'CONDITIONAL_BUY_CREATE',
          failureStage: 'conditional_registration_price_selection',
          entities: { tradingAccountId: accountId, assetId: asset.id },
          evidence: {
            evaluationState: 'reference_unavailable',
            priceEvidenceAvailable: false,
          },
        });
        throw createApiError(
          'CONDITIONAL_PRICE_UNAVAILABLE',
          'A fresh eligible reference price is required.',
          409,
        );
      }
      if (
        isConditionalBuyMet(
          input.triggerCondition,
          price.price,
          input.triggerPrice,
        )
      )
        throw createApiError(
          'CONDITIONAL_BUY_ALREADY_MET',
          'The current price already meets this condition.',
          409,
        );
      const row = await tx.conditionalBuyOrder.create({
        data: {
          tradingAccountId: accountId,
          assetId: asset.id,
          triggerCondition: input.triggerCondition,
          triggerPrice: input.triggerPrice,
          executionType: input.executionType,
          limitPrice: input.limitPrice,
          quantity: input.quantity,
          amount: input.amount,
          currencyCode: asset.settlementCurrency,
          registrationSnapshotId: price.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          createdAt: now,
        },
        include: CONDITIONAL_BUY_INCLUDE,
      });
      if (!conditionalTradable(account, await this.now(tx)))
        throw createApiError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
          409,
        );
      return this.response(accountId, row, false);
    });
  }

  async cancel(userId: string | undefined, accountId: string, id: string) {
    this.user(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      await tx.$queryRaw`SELECT "id" FROM "conditional_buy_orders" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
      const row = await tx.conditionalBuyOrder.findFirst({
        where: { id, tradingAccountId: accountId },
        include: CONDITIONAL_BUY_INCLUDE,
      });
      if (!row)
        throw createApiError(
          'CONDITIONAL_BUY_NOT_FOUND',
          'Conditional order not found.',
          404,
        );
      if (row.status === 'ordered')
        throw createApiError(
          'CONDITIONAL_BUY_ALREADY_ORDERED',
          'The order was already submitted; manage it as an ordinary order.',
          409,
        );
      if (row.status === 'watching' || row.status === 'triggered') {
        const now = await this.now(tx);
        const updated = await tx.conditionalBuyOrder.update({
          where: { id },
          data: {
            status: 'canceled',
            terminalReason: 'user_canceled',
            endedAt: now,
          },
          include: CONDITIONAL_BUY_INCLUDE,
        });
        return this.response(accountId, updated, false);
      }
      return this.response(accountId, row, true);
    });
  }

  async get(userId: string | undefined, accountId: string, id: string) {
    this.user(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    const row = await this.prisma.conditionalBuyOrder.findFirst({
      where: { id, tradingAccountId: accountId },
      include: CONDITIONAL_BUY_INCLUDE,
    });
    if (!row)
      throw createApiError(
        'CONDITIONAL_BUY_NOT_FOUND',
        'Conditional order not found.',
        404,
      );
    return this.response(accountId, row, false);
  }

  async list(
    userId: string | undefined,
    accountId: string,
    query: ConditionalBuyListQuery,
  ) {
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
      (query.history !== undefined &&
        !['true', 'false'].includes(query.history)) ||
      (query.state !== undefined &&
        (!['open', 'ended'].includes(query.state) ||
          query.history !== undefined))
    )
      throw createApiError('INVALID_PAGINATION', 'Invalid history query.', 400);
    const where: Prisma.ConditionalBuyOrderWhereInput = {
      tradingAccountId: accountId,
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.state === 'open'
        ? openConditionalBuy
        : query.state === 'ended'
          ? { NOT: openConditionalBuy }
          : query.history === 'true'
            ? {}
            : liveConditionalBuy),
    };
    const [rows, total, clock] = await Promise.all([
      this.prisma.conditionalBuyOrder.findMany({
        where,
        include: CONDITIONAL_BUY_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.conditionalBuyOrder.count({ where }),
      this.now(this.prisma),
    ]);
    const enabled = conditionalBuyEnabled();
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        capabilities: {
          enabled,
          canCreate: enabled && conditionalTradable(account, clock),
          canCancel: true,
          canUseLimit:
            enabled &&
            isLimitOrderEnabled() &&
            readLimitOrderMatchingConfig().matchingEnabled,
          markets: ['KRX', 'CRYPTO_SPOT'],
          maxLivePerAccount: CONDITIONAL_BUY_MAX_LIVE_PER_ACCOUNT,
        },
        conditionalOrders: rows.map((row) => presentConditionalBuy(row)),
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
   * fence before any order attempt; the attempt itself runs through the
   * ordinary quote/create core with no lock held here.
   */
  async evaluate(id: string): Promise<{ state: string }> {
    const target = await this.prisma.conditionalBuyOrder.findUnique({
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
      await tx.$queryRaw`SELECT "id" FROM "conditional_buy_orders" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.conditionalBuyOrder.findUnique({
        where: { id },
        include: { asset: true },
      });
      if (!row || (row.status !== 'watching' && row.status !== 'triggered'))
        return { state: 'terminal' };
      const now = await this.now(tx);
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
      if (!row.asset.isActive || isFuturesOnlyAsset(row.asset)) {
        await this.terminate(tx, id, 'canceled', 'asset_not_tradable', now);
        return { state: 'lifecycle_canceled' };
      }
      if (row.status === 'triggered') {
        if (
          !row.triggeredAt ||
          conditionalBuyWindowExpired(row.triggeredAt, now) ||
          row.attemptCount >= CONDITIONAL_BUY_MAX_ATTEMPTS
        ) {
          await this.terminate(
            tx,
            id,
            'failed',
            'execution_window_expired',
            now,
            row.failureCode ?? 'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED',
          );
          return { state: 'failed' };
        }
        return conditionalBuyEnabled()
          ? { state: 'execute' }
          : { state: 'disabled' };
      }
      if (!conditionalBuyEnabled()) return { state: 'disabled' };
      const price = await conditionalPrice(tx, row.asset, 'spot', now);
      if (!price) return { state: 'price_unavailable' };
      // Only evidence of a trade after registration may trigger the watch.
      if (price.effectiveAt < row.createdAt) return { state: 'awaiting_price' };
      if (
        !isConditionalBuyMet(
          row.triggerCondition,
          price.price,
          row.triggerPrice,
        )
      )
        return { state: 'watching' };
      await tx.conditionalBuyOrder.update({
        where: { id },
        data: {
          status: 'triggered',
          triggeredAt: now,
          triggerSnapshotId: price.id,
          triggerEvidenceJson: {
            assetId: row.assetId,
            symbol: row.asset.symbol,
            triggerCondition: row.triggerCondition,
            triggerPrice: row.triggerPrice.toFixed(8),
            price: price.price.toFixed(8),
            currencyCode: price.currencyCode,
            priceBasis: price.kind,
            sourceType: price.sourceType,
            sourceName: price.sourceName,
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
      const created = await this.orders.executeConditionalBuy(
        userId,
        accountId,
        id,
      );
      return { state: created ? 'ordered' : 'terminal' };
    } catch (error) {
      const code = apiErrorCode(error, 'CONDITIONAL_BUY_EXECUTION_FAILED');
      await this.recordAttemptFailure(id, accountId, userId, code);
      return { state: code };
    }
  }

  private async recordAttemptFailure(
    id: string,
    accountId: string,
    userId: string,
    code: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      await tx.$queryRaw`SELECT "id" FROM "conditional_buy_orders" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.conditionalBuyOrder.findUnique({ where: { id } });
      if (row?.status !== 'triggered' || !row.triggeredAt) return;
      const now = await this.now(tx);
      const attempts = row.attemptCount + 1;
      const terminal =
        !isRetryableConditionalBuyFailure(code) ||
        attempts >= CONDITIONAL_BUY_MAX_ATTEMPTS ||
        conditionalBuyWindowExpired(row.triggeredAt, now);
      // The create refused a trigger past its window: the same end as the
      // evaluation pre-check, keeping an earlier attempt's root cause.
      const windowExpired = code === 'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED';
      await tx.conditionalBuyOrder.update({
        where: { id },
        data: {
          attemptCount: attempts,
          lastAttemptAt: now,
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
    reason: string,
    now: Date,
    failureCode?: string,
  ) {
    await tx.conditionalBuyOrder.updateMany({
      where: { id, ...liveConditionalBuy },
      data: {
        status,
        terminalReason: reason,
        endedAt: now,
        ...(failureCode ? { failureCode } : {}),
      },
    });
  }

  private response(
    accountId: string,
    row: ConditionalBuyRecord,
    duplicate: boolean,
  ) {
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        conditionalOrder: presentConditionalBuy(row),
        duplicate,
      },
    };
  }

  private user(userId: string | undefined): asserts userId is string {
    if (!userId) throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
  }

  /** Existing financial writer fence (same as protection commands). */
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
    if (account.mode === 'season')
      await lockSeasonTradingContext(tx, {
        seasonParticipantId: account.seasonParticipant!.id,
        userId,
        participantWrite: true,
      });
    else
      await tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${accountId} AND user_id = ${userId} FOR UPDATE`;
  }

  private async now(client: Pick<Prisma.TransactionClient, '$queryRaw'>) {
    const [row] = await client.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    return row.now;
  }
}

/** Watch state is distinct from the actual Order's execution state. */
export function presentConditionalBuy(row: ConditionalBuyRecord) {
  const order = row.order;
  const money = (value: Prisma.Decimal | null) =>
    value ? formatDecimalScale(value, monetaryScale) : null;
  return {
    id: row.id,
    assetId: row.assetId,
    asset: row.asset,
    side: 'buy' as const,
    triggerCondition: row.triggerCondition,
    triggerPrice: formatDecimalScale(row.triggerPrice, monetaryScale),
    executionType: row.executionType,
    limitPrice: money(row.limitPrice),
    quantity: money(row.quantity),
    amount: money(row.amount),
    currencyCode: row.currencyCode,
    status: row.status,
    state:
      row.status !== 'ordered'
        ? row.status
        : order?.status === 'executed'
          ? 'filled'
          : order?.status === 'submitted'
            ? 'order_pending'
            : order?.status === 'canceled'
              ? 'order_canceled'
              : 'order_rejected',
    trigger: row.triggeredAt
      ? {
          triggeredAt: row.triggeredAt.toISOString(),
          snapshotId: row.triggerSnapshotId,
          evidence: row.triggerEvidenceJson,
        }
      : null,
    order: order
      ? {
          orderId: order.id,
          orderType: order.orderType,
          status: order.status,
          quantity: formatDecimalScale(order.quantity, monetaryScale),
          executedQuantity: money(order.executedQuantity),
          limitPrice: money(order.limitPrice),
          executedPrice: money(order.executedPrice),
          grossAmount: money(order.grossAmount),
          feeAmount: money(order.feeAmount),
          netAmount: money(order.netAmount),
          reservedAmount: money(order.reservedAmount),
          cancelReason: order.cancelReason,
          assetPriceSnapshotId: order.assetPriceSnapshotId,
          limitOrderCandleEvidenceId: order.limitOrderCandleEvidenceId,
          submittedAt: order.submittedAt.toISOString(),
          executedAt: order.executedAt?.toISOString() ?? null,
          canceledAt: order.canceledAt?.toISOString() ?? null,
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
