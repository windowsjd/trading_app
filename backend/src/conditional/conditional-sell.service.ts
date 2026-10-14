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
import { liveProtection } from './conditional-state';
import {
  assertConditionalSellKindEnabled,
  CONDITIONAL_SELL_MAX_ATTEMPTS,
  CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT,
  conditionalSellEnabled,
  conditionalSellHash,
  conditionalSellKindEnabled,
  conditionalSellWindowExpired,
  findProtectionSettingConflict,
  independentTpSlEnabled,
  isConditionalSellMet,
  isRetryableConditionalSellFailure,
  parseConditionalSellBody,
  resolveSellExecutionQuantity,
  type ConditionalSellBody,
} from './conditional-sell-policy';
import {
  liveConditionalSell,
  openConditionalSell,
  type ConditionalSellLifecycleReason,
} from './conditional-sell-state';

const CONDITIONAL_SELL_INCLUDE = {
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
      canceledQuantity: true,
      limitPrice: true,
      executedPrice: true,
      grossAmount: true,
      feeAmount: true,
      netAmount: true,
      reservedQuantity: true,
      cancelReason: true,
      assetPriceSnapshotId: true,
      limitOrderCandleEvidenceId: true,
      submittedAt: true,
      executedAt: true,
      canceledAt: true,
    },
  },
} as const;

type ConditionalSellRecord = Prisma.ConditionalSellOrderGetPayload<{
  include: typeof CONDITIONAL_SELL_INCLUDE;
}>;

type PositionFacts = {
  id: string;
  quantity: Prisma.Decimal;
  reservedQuantity: Prisma.Decimal;
};

type ConditionalSellListQuery = {
  limit?: string;
  offset?: string;
  assetId?: string;
  history?: string;
  /** `open` | `ended`; not combined with `history`. */
  state?: string;
  /** `condition` | `protection` (stop-loss and take-profit). */
  kind?: string;
};

/**
 * SELL intents on an open Spot holding (KRX stocks, crypto Spot): a user
 * condition, independent stop-losses and independent take-profits. None
 * reserves quantity; the live stop-losses (and, separately, take-profits) of
 * a holding target at most the holding at registration, while conditions and
 * the two families may together target more. New stop-loss/take-profit
 * settings sell at market. Once its eligible trigger is recorded, an intent submits ONE
 * ordinary market or limit SELL through OrdersService, sized there and then
 * to min(target, holding − other orders' reservations). Lifecycle
 * authorization uses the existing Season → Account → Participant / General
 * Account fence; the created Order is settled entirely by existing cores
 * (market execute or the limit matcher).
 */
@Injectable()
export class ConditionalSellService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly orders: OrdersService,
  ) {}

  async create(
    userId: string | undefined,
    accountId: string,
    body: ConditionalSellBody,
  ) {
    this.user(userId);
    const input = parseConditionalSellBody(body);
    const hash = conditionalSellHash(input);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      const committed = await tx.conditionalSellOrder.findMany({
        where: {
          tradingAccountId: accountId,
          idempotencyKey: input.idempotencyKey,
        },
        include: CONDITIONAL_SELL_INCLUDE,
        orderBy: { kind: 'asc' },
      });
      if (committed.length) {
        if (committed.some((row) => row.requestHash !== hash))
          throw createApiError(
            'CONDITIONAL_IDEMPOTENCY_CONFLICT',
            'The command differs from the committed request.',
            409,
          );
        return this.response(accountId, committed, true, null);
      }
      for (const intent of input.intents)
        assertConditionalSellKindEnabled(intent.kind);
      if (
        input.intents.some((intent) => intent.executionType === 'limit') &&
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
      // US stocks wait for an approved quote and close data provider.
      if (asset.assetType === 'us_stock')
        throw createApiError(
          'CONDITIONAL_SELL_MARKET_NOT_SUPPORTED',
          'Conditional sell orders are available for Korean stocks and crypto.',
          409,
        );
      if (input.currencyCode && input.currencyCode !== asset.settlementCurrency)
        throw createApiError(
          'ASSET_CURRENCY_MISMATCH',
          'currencyCode must match asset settlementCurrency.',
          400,
        );
      for (const intent of input.intents)
        assertOrderInputPolicy({
          assetType: asset.assetType,
          side: 'sell',
          orderType: intent.executionType,
          quantity: intent.quantity,
          amount: null,
        });
      // Registering automation is an advanced action on a beginner account;
      // the resulting SELL itself stays risk reduction. A crypto stop-loss/
      // take-profit is the TP/SL practice (QUEST 04), opened at the same step
      // as the whole-position protection it replaces there; a user condition
      // and every other market keep full trading access.
      await assertBeginnerLearningAccess(
        tx,
        account,
        input.intents[0].kind !== 'condition' && asset.assetType === 'crypto'
          ? 'spotProtection'
          : 'allTrading',
      );
      const live = await tx.conditionalSellOrder.count({
        where: { tradingAccountId: accountId, ...liveConditionalSell },
      });
      if (live + input.intents.length > CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT)
        throw createApiError(
          'CONDITIONAL_SELL_LIMIT_EXCEEDED',
          'Too many active conditional sell orders.',
          409,
        );
      // Whole-position OCO protection and independent SELL intents never
      // share a holding: an OCO child sells and reserves the whole position.
      const protection = await tx.protectionGroup.count({
        where: {
          tradingAccountId: accountId,
          assetId: asset.id,
          domain: 'spot',
          ...liveProtection,
        },
      });
      if (protection)
        throw createApiError(
          'PROTECTION_CONFLICT',
          'Cancel the existing TP/SL protection before adding sell conditions.',
          409,
        );
      // Every writer of the holding quantity takes the same fence, so this
      // read is the holding the intents are registered against.
      const position = await tx.position.findUnique({
        where: {
          tradingAccountId_assetId: {
            tradingAccountId: accountId,
            assetId: asset.id,
          },
        },
        select: { id: true, quantity: true, reservedQuantity: true },
      });
      if (!position || position.quantity.lte(0))
        throw createApiError(
          'CONDITIONAL_SELL_POSITION_UNAVAILABLE',
          'An open position is required.',
          409,
        );
      // Each target is checked alone: a condition and the stop-loss and
      // take-profit families may together add up to more than this.
      if (input.intents.some((intent) => intent.quantity.gt(position.quantity)))
        throw createApiError(
          'CONDITIONAL_SELL_QUANTITY_EXCEEDS_HOLDING',
          'The quantity exceeds the current holding.',
          409,
        );
      // Within one stop-loss or take-profit family the live targets stay
      // within the holding and use distinct prices (same fence as every
      // registration of this account, so concurrent creates serialize here).
      const protectionKinds = input.intents
        .map((intent) => intent.kind)
        .filter((kind) => kind !== 'condition');
      if (protectionKinds.length) {
        const conflict = findProtectionSettingConflict({
          intents: input.intents,
          live: await tx.conditionalSellOrder.findMany({
            where: {
              tradingAccountId: accountId,
              assetId: asset.id,
              positionId: position.id,
              kind: { in: protectionKinds },
              ...liveConditionalSell,
            },
            select: { kind: true, triggerPrice: true, quantity: true },
          }),
          holding: position.quantity,
        });
        if (conflict === 'duplicate_price')
          throw createApiError(
            'CONDITIONAL_SELL_DUPLICATE_PRICE',
            'An active setting of the same kind already uses this price.',
            409,
          );
        if (conflict === 'total_exceeds_holding')
          throw createApiError(
            'CONDITIONAL_SELL_TOTAL_EXCEEDS_HOLDING',
            'Active settings of the same kind would exceed the current holding.',
            409,
          );
      }
      const price = await conditionalPrice(tx, asset, 'spot', now);
      if (!price) {
        setAdminDiagnosticContext({
          domain: 'CONDITIONAL',
          operation: 'CONDITIONAL_SELL_CREATE',
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
        input.intents.some((intent) =>
          isConditionalSellMet(
            intent.triggerCondition,
            price.price,
            intent.triggerPrice,
          ),
        )
      )
        throw createApiError(
          'CONDITIONAL_SELL_ALREADY_MET',
          'The current price already meets this condition.',
          409,
        );
      const rows: ConditionalSellRecord[] = [];
      for (const intent of input.intents)
        rows.push(
          await tx.conditionalSellOrder.create({
            data: {
              tradingAccountId: accountId,
              assetId: asset.id,
              positionId: position.id,
              kind: intent.kind,
              triggerCondition: intent.triggerCondition,
              triggerPrice: intent.triggerPrice,
              executionType: intent.executionType,
              limitPrice: intent.limitPrice,
              quantity: intent.quantity,
              currencyCode: asset.settlementCurrency,
              registrationSnapshotId: price.id,
              idempotencyKey: input.idempotencyKey,
              requestHash: hash,
              createdAt: now,
            },
            include: CONDITIONAL_SELL_INCLUDE,
          }),
        );
      if (!conditionalTradable(account, await this.now(tx)))
        throw createApiError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
          409,
        );
      return this.response(accountId, rows, false, position);
    });
  }

  async cancel(userId: string | undefined, accountId: string, id: string) {
    this.user(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      await tx.$queryRaw`SELECT "id" FROM "conditional_sell_orders" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
      const row = await tx.conditionalSellOrder.findFirst({
        where: { id, tradingAccountId: accountId },
        include: CONDITIONAL_SELL_INCLUDE,
      });
      if (!row)
        throw createApiError(
          'CONDITIONAL_SELL_NOT_FOUND',
          'Conditional order not found.',
          404,
        );
      if (row.status === 'ordered')
        throw createApiError(
          'CONDITIONAL_SELL_ALREADY_ORDERED',
          'The order was already submitted; manage it as an ordinary order.',
          409,
        );
      if (row.status === 'watching' || row.status === 'triggered') {
        const now = await this.now(tx);
        const updated = await tx.conditionalSellOrder.update({
          where: { id },
          data: {
            status: 'canceled',
            terminalReason: 'user_canceled',
            endedAt: now,
          },
          include: CONDITIONAL_SELL_INCLUDE,
        });
        return this.single(accountId, updated, false);
      }
      return this.single(accountId, row, true);
    });
  }

  async get(userId: string | undefined, accountId: string, id: string) {
    this.user(userId);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    const row = await this.prisma.conditionalSellOrder.findFirst({
      where: { id, tradingAccountId: accountId },
      include: CONDITIONAL_SELL_INCLUDE,
    });
    if (!row)
      throw createApiError(
        'CONDITIONAL_SELL_NOT_FOUND',
        'Conditional order not found.',
        404,
      );
    const positions = await this.positions(accountId, [row]);
    return this.single(accountId, row, false, positions);
  }

  async list(
    userId: string | undefined,
    accountId: string,
    query: ConditionalSellListQuery,
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
          query.history !== undefined)) ||
      (query.kind !== undefined &&
        !['condition', 'protection'].includes(query.kind))
    )
      throw createApiError('INVALID_PAGINATION', 'Invalid history query.', 400);
    const where: Prisma.ConditionalSellOrderWhereInput = {
      tradingAccountId: accountId,
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.kind === 'condition'
        ? { kind: 'condition' }
        : query.kind === 'protection'
          ? { kind: { in: ['stop_loss', 'take_profit'] } }
          : {}),
      ...(query.state === 'open'
        ? openConditionalSell
        : query.state === 'ended'
          ? { NOT: openConditionalSell }
          : query.history === 'true'
            ? {}
            : liveConditionalSell),
    };
    const [rows, total, clock] = await Promise.all([
      this.prisma.conditionalSellOrder.findMany({
        where,
        include: CONDITIONAL_SELL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.conditionalSellOrder.count({ where }),
      this.now(this.prisma),
    ]);
    const positions = await this.positions(accountId, rows);
    const tradable = conditionalTradable(account, clock);
    const canUseLimit =
      isLimitOrderEnabled() && readLimitOrderMatchingConfig().matchingEnabled;
    const conditionEnabled = conditionalSellEnabled();
    const protectionEnabled = independentTpSlEnabled();
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        capabilities: {
          enabled: conditionEnabled || protectionEnabled,
          condition: {
            enabled: conditionEnabled,
            canCreate: conditionEnabled && tradable,
            canUseLimit: conditionEnabled && canUseLimit,
          },
          protection: {
            enabled: protectionEnabled,
            canCreate: protectionEnabled && tradable,
            // New stop-loss/take-profit settings execute at market only.
            canUseLimit: false,
          },
          canCancel: true,
          markets: ['KRX', 'CRYPTO_SPOT'],
          maxLivePerAccount: CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT,
        },
        conditionalOrders: rows.map((row) =>
          presentConditionalSell(row, positions),
        ),
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
   * Worker step for one intent. Trigger evidence commits under the lifecycle
   * fence before any order attempt; the attempt itself runs through the
   * ordinary quote/create core with no lock held here.
   */
  async evaluate(id: string): Promise<{ state: string }> {
    const target = await this.prisma.conditionalSellOrder.findUnique({
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
      await tx.$queryRaw`SELECT "id" FROM "conditional_sell_orders" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.conditionalSellOrder.findUnique({
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
      // Safety net: the flat-making SELL already ended the intent in its
      // own transaction; a holding gone by other means ends it here.
      const position = await tx.position.findUnique({
        where: {
          tradingAccountId_assetId: {
            tradingAccountId: accountId,
            assetId: row.assetId,
          },
        },
        select: { id: true, quantity: true },
      });
      if (
        !position ||
        position.id !== row.positionId ||
        position.quantity.lte(0)
      ) {
        await this.terminate(tx, id, 'canceled', 'position_closed', now);
        return { state: 'position_closed' };
      }
      const enabled = conditionalSellKindEnabled(row.kind);
      if (row.status === 'triggered') {
        if (
          !row.triggeredAt ||
          conditionalSellWindowExpired(row.triggeredAt, now) ||
          row.attemptCount >= CONDITIONAL_SELL_MAX_ATTEMPTS
        ) {
          await this.terminate(
            tx,
            id,
            'failed',
            'execution_window_expired',
            now,
            row.failureCode ?? 'CONDITIONAL_SELL_EXECUTION_WINDOW_EXPIRED',
          );
          return { state: 'failed' };
        }
        return enabled ? { state: 'execute' } : { state: 'disabled' };
      }
      if (!enabled) return { state: 'disabled' };
      const price = await conditionalPrice(tx, row.asset, 'spot', now);
      if (!price) return { state: 'price_unavailable' };
      // Only evidence of a trade after registration may trigger the intent.
      if (price.effectiveAt < row.createdAt) return { state: 'awaiting_price' };
      if (
        !isConditionalSellMet(
          row.triggerCondition,
          price.price,
          row.triggerPrice,
        )
      )
        return { state: 'watching' };
      await tx.conditionalSellOrder.update({
        where: { id },
        data: {
          status: 'triggered',
          triggeredAt: now,
          triggerSnapshotId: price.id,
          triggerEvidenceJson: {
            assetId: row.assetId,
            symbol: row.asset.symbol,
            kind: row.kind,
            positionId: row.positionId,
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
      const created = await this.orders.executeConditionalSell(
        userId,
        accountId,
        id,
      );
      return { state: created ? 'ordered' : 'terminal' };
    } catch (error) {
      const code = apiErrorCode(error, 'CONDITIONAL_SELL_EXECUTION_FAILED');
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
      await tx.$queryRaw`SELECT "id" FROM "conditional_sell_orders" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.conditionalSellOrder.findUnique({ where: { id } });
      if (row?.status !== 'triggered' || !row.triggeredAt) return;
      const now = await this.now(tx);
      const attempts = row.attemptCount + 1;
      const terminal =
        !isRetryableConditionalSellFailure(code) ||
        attempts >= CONDITIONAL_SELL_MAX_ATTEMPTS ||
        conditionalSellWindowExpired(row.triggeredAt, now);
      // The create refused a trigger past its window: the same end as the
      // evaluation pre-check, keeping an earlier attempt's root cause.
      const windowExpired =
        code === 'CONDITIONAL_SELL_EXECUTION_WINDOW_EXPIRED';
      await tx.conditionalSellOrder.update({
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
                  : code === 'CONDITIONAL_SELL_QUANTITY_UNAVAILABLE'
                    ? 'quantity_unavailable'
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
    reason: ConditionalSellLifecycleReason | 'execution_window_expired',
    now: Date,
    failureCode?: string,
  ) {
    await tx.conditionalSellOrder.updateMany({
      where: { id, ...liveConditionalSell },
      data: {
        status,
        terminalReason: reason,
        endedAt: now,
        ...(failureCode ? { failureCode } : {}),
      },
    });
  }

  /** Current holding facts for the live rows (display only, never money). */
  private async positions(
    accountId: string,
    rows: Array<Pick<ConditionalSellRecord, 'assetId' | 'status'>>,
    client: Pick<Prisma.TransactionClient, 'position'> = this.prisma,
  ) {
    const assetIds = [
      ...new Set(
        rows
          .filter(
            (row) => row.status === 'watching' || row.status === 'triggered',
          )
          .map((row) => row.assetId),
      ),
    ];
    if (!assetIds.length) return new Map<string, PositionFacts>();
    const positions = await client.position.findMany({
      where: { tradingAccountId: accountId, assetId: { in: assetIds } },
      select: {
        id: true,
        assetId: true,
        quantity: true,
        reservedQuantity: true,
      },
    });
    return new Map(positions.map((row) => [row.assetId, row]));
  }

  private response(
    accountId: string,
    rows: ConditionalSellRecord[],
    duplicate: boolean,
    position: PositionFacts | null,
  ) {
    const positions = new Map<string, PositionFacts>();
    if (position && rows[0]) positions.set(rows[0].assetId, position);
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        conditionalOrders: rows.map((row) =>
          presentConditionalSell(row, positions),
        ),
        duplicate,
      },
    };
  }

  private single(
    accountId: string,
    row: ConditionalSellRecord,
    duplicate: boolean,
    positions = new Map<string, PositionFacts>(),
  ) {
    return {
      success: true as const,
      data: {
        tradingAccountId: accountId,
        conditionalOrder: presentConditionalSell(row, positions),
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

/**
 * Intent state is distinct from the actual Order's execution state: `filled`
 * exists only when the linked Order executed. `quantity` is the user's
 * target; `order.quantity` is what was really submitted (it may be smaller:
 * other orders held part of the holding), and `order.executedQuantity` what
 * really filled. `position` (live rows only) is the current holding and what
 * a trigger now would size to — informational, the order core decides.
 */
export function presentConditionalSell(
  row: ConditionalSellRecord,
  positions: Map<string, PositionFacts>,
) {
  const order = row.order;
  const money = (value: Prisma.Decimal | null) =>
    value ? formatDecimalScale(value, monetaryScale) : null;
  const live = row.status === 'watching' || row.status === 'triggered';
  const position = live ? positions.get(row.assetId) : undefined;
  const sizing =
    position && position.id === row.positionId
      ? resolveSellExecutionQuantity({
          target: row.quantity,
          holding: position.quantity,
          reserved: position.reservedQuantity,
          assetType: row.asset.assetType,
          orderType: row.executionType,
        })
      : null;
  return {
    id: row.id,
    assetId: row.assetId,
    asset: row.asset,
    side: 'sell' as const,
    kind: row.kind,
    positionId: row.positionId,
    triggerCondition: row.triggerCondition,
    triggerPrice: formatDecimalScale(row.triggerPrice, monetaryScale),
    executionType: row.executionType,
    limitPrice: money(row.limitPrice),
    quantity: formatDecimalScale(row.quantity, monetaryScale),
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
    position:
      position && sizing
        ? {
            holdingQuantity: money(position.quantity),
            reservedQuantity: money(position.reservedQuantity),
            availableQuantity: money(sizing.available),
            executableQuantity: money(sizing.quantity),
          }
        : null,
    executionAvailableQuantity: money(row.executionAvailableQuantity),
    quantityLimited: !!order && order.quantity.lt(row.quantity),
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
          canceledQuantity: money(order.canceledQuantity),
          limitPrice: money(order.limitPrice),
          executedPrice: money(order.executedPrice),
          grossAmount: money(order.grossAmount),
          feeAmount: money(order.feeAmount),
          netAmount: money(order.netAmount),
          reservedQuantity: money(order.reservedQuantity),
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
