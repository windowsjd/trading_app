import { createApiError } from '../common/api-error';
import {
  Prisma,
  type AssetType,
  type CurrencyCode,
  type EntryTpSlPlan,
  type FuturesDirection,
  type OrderStatus,
  type OrderType,
} from '../generated/prisma/client';
import { orderInputQuantityScale } from '../orders/order-input-policy';
import { FUTURES_TP_SL_MAX_LIVE_PER_ACCOUNT } from '../futures/futures-tp-sl-policy';
import { liveFuturesTpSl } from '../futures/futures-tp-sl-state';
import { conditionalHash } from './conditional-policy';
import {
  CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT,
  findProtectionSettingConflict,
} from './conditional-sell-policy';
import { liveConditionalSell } from './conditional-sell-state';
import { liveProtection } from './conditional-state';
import {
  assertEntryTriggerSides,
  ENTRY_TP_SL_MAX_PENDING_PER_ACCOUNT,
  ENTRY_TP_SL_MAX_PER_ENTRY,
  entryPlanTargetQuantity,
  findEntryPlanConflict,
  type EntryTpSlIntent,
  type EntryType,
} from './entry-tp-sl-policy';

export const pendingEntryTpSl = { status: 'pending' as const };

type Client = Prisma.TransactionClient;

export type EntryLink =
  | { orderId: string }
  | { conditionalBuyOrderId: string }
  | { futuresLimitOrderId: string }
  | { futuresConditionalEntryId: string };

/** The entry a plan set belongs to, resolved from the id the client holds. */
export type EntryRoot = {
  type: EntryType;
  id: string;
  domain: 'spot' | 'futures';
  link: EntryLink;
  assetId: string;
  asset: {
    id: string;
    symbol: string;
    name: string;
    market: string;
    assetType: AssetType;
  };
  instrumentId: string | null;
  direction: FuturesDirection;
  /** `open` accepts plans; `filled` and `ended` never will again. */
  state: 'open' | 'filled' | 'ended';
  /** False for entries plans never attach to (a SELL or LOC order). */
  supported: boolean;
  executionType: OrderType;
  /** The price plan triggers are checked against: the entry's limit, or the
   * conditional trigger when the entry executes at market. */
  entryPrice: Prisma.Decimal;
  triggerPrice: Prisma.Decimal | null;
  limitPrice: Prisma.Decimal | null;
  /** Quantity the entry would acquire if it fills completely. Null when it
   * is decided only at execution (a crypto conditional BUY by amount). */
  expectedQuantity: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  currencyCode: CurrencyCode;
  leverage: number | null;
  /** An OCO group attached to the entry (legacy) owns its future holding. */
  legacyProtection: boolean;
  /** The order a conditional entry created (Spot Order / Futures limit). */
  childOrderId: string | null;
};

const ASSET_SELECT = {
  id: true,
  symbol: true,
  name: true,
  market: true,
  assetType: true,
} as const;

const FUTURES_INSTRUMENT_SELECT = {
  id: true,
  underlyingAsset: { select: ASSET_SELECT },
} as const;

/**
 * Resolves an entry for plans. With `lock`, the addressed rows are locked
 * FOR UPDATE after the caller's account fence (the order every writer of the
 * entry takes), so the state read here is the one the registration commits
 * against: a concurrent fill or cancel either committed first or waits.
 */
export async function resolveEntryRoot(
  tx: Pick<
    Client,
    | '$queryRaw'
    | 'order'
    | 'conditionalBuyOrder'
    | 'futuresLimitOrder'
    | 'futuresConditionalEntry'
  >,
  accountId: string,
  type: EntryType,
  id: string,
  lock: boolean,
): Promise<EntryRoot | null> {
  if (type === 'spot_limit_order') {
    if (lock)
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id, tradingAccountId: accountId },
      select: {
        id: true,
        assetId: true,
        side: true,
        orderType: true,
        status: true,
        quantity: true,
        limitPrice: true,
        currencyCode: true,
        asset: { select: ASSET_SELECT },
        conditionalBuy: { select: { id: true } },
        limitOnClose: { select: { orderId: true } },
        attachedProtection: { select: { status: true } },
      },
    });
    if (!order) return null;
    // The order of a conditional BUY carries that watch's plans.
    if (order.conditionalBuy)
      return resolveEntryRoot(
        tx,
        accountId,
        'spot_conditional_buy',
        order.conditionalBuy.id,
        lock,
      );
    return {
      type,
      id: order.id,
      domain: 'spot',
      link: { orderId: order.id },
      assetId: order.assetId,
      asset: order.asset,
      instrumentId: null,
      direction: 'long',
      state:
        order.status === 'submitted'
          ? 'open'
          : order.status === 'executed'
            ? 'filled'
            : 'ended',
      supported:
        order.side === 'buy' &&
        order.orderType === 'limit' &&
        !order.limitOnClose &&
        !!order.limitPrice,
      executionType: order.orderType,
      entryPrice: order.limitPrice ?? new Prisma.Decimal(0),
      triggerPrice: null,
      limitPrice: order.limitPrice,
      expectedQuantity: order.quantity,
      amount: null,
      currencyCode: order.currencyCode,
      leverage: null,
      legacyProtection:
        order.attachedProtection?.status === 'holding' ||
        order.attachedProtection?.status === 'active',
      childOrderId: null,
    };
  }
  if (type === 'spot_conditional_buy') {
    if (lock)
      await tx.$queryRaw`SELECT "id" FROM "conditional_buy_orders" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
    const row = await tx.conditionalBuyOrder.findFirst({
      where: { id, tradingAccountId: accountId },
      select: {
        id: true,
        assetId: true,
        status: true,
        executionType: true,
        triggerPrice: true,
        limitPrice: true,
        quantity: true,
        amount: true,
        currencyCode: true,
        asset: { select: ASSET_SELECT },
        order: { select: { id: true, status: true, quantity: true } },
      },
    });
    if (!row) return null;
    const order = row.order;
    return {
      type,
      id: row.id,
      domain: 'spot',
      link: { conditionalBuyOrderId: row.id },
      assetId: row.assetId,
      asset: row.asset,
      instrumentId: null,
      direction: 'long',
      state:
        row.status === 'watching' || row.status === 'triggered'
          ? 'open'
          : row.status === 'ordered' && order?.status === 'submitted'
            ? 'open'
            : row.status === 'ordered' && order?.status === 'executed'
              ? 'filled'
              : 'ended',
      supported: true,
      executionType: row.executionType,
      entryPrice: row.limitPrice ?? row.triggerPrice,
      triggerPrice: row.triggerPrice,
      limitPrice: row.limitPrice,
      // The created order's quantity is exact; before that a stock watch
      // knows its quantity and a crypto watch only its amount.
      expectedQuantity: order?.quantity ?? row.quantity,
      amount: row.amount,
      currencyCode: row.currencyCode,
      leverage: null,
      legacyProtection: false,
      childOrderId: order?.id ?? null,
    };
  }
  if (type === 'futures_limit_order') {
    if (lock)
      await tx.$queryRaw`SELECT "id" FROM "futures_limit_orders" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
    const row = await tx.futuresLimitOrder.findFirst({
      where: { id, tradingAccountId: accountId },
      select: {
        id: true,
        instrumentId: true,
        direction: true,
        leverage: true,
        quantity: true,
        limitPrice: true,
        status: true,
        instrument: { select: FUTURES_INSTRUMENT_SELECT },
        conditionalEntry: { select: { id: true } },
        protection: { select: { status: true } },
      },
    });
    if (!row) return null;
    // The limit entry of a conditional entry carries that watch's plans.
    if (row.conditionalEntry)
      return resolveEntryRoot(
        tx,
        accountId,
        'futures_conditional_entry',
        row.conditionalEntry.id,
        lock,
      );
    return {
      type,
      id: row.id,
      domain: 'futures',
      link: { futuresLimitOrderId: row.id },
      assetId: row.instrument.underlyingAsset.id,
      asset: row.instrument.underlyingAsset,
      instrumentId: row.instrumentId,
      direction: row.direction,
      state:
        row.status === 'submitted'
          ? 'open'
          : row.status === 'executed'
            ? 'filled'
            : 'ended',
      supported: true,
      executionType: 'limit',
      entryPrice: row.limitPrice,
      triggerPrice: null,
      limitPrice: row.limitPrice,
      expectedQuantity: row.quantity,
      amount: null,
      currencyCode: 'USD',
      leverage: row.leverage,
      legacyProtection:
        row.protection?.status === 'holding' ||
        row.protection?.status === 'active',
      childOrderId: null,
    };
  }
  if (lock)
    await tx.$queryRaw`SELECT "id" FROM "futures_conditional_entries" WHERE "id" = ${id} AND "trading_account_id" = ${accountId} FOR UPDATE`;
  const row = await tx.futuresConditionalEntry.findFirst({
    where: { id, tradingAccountId: accountId },
    select: {
      id: true,
      instrumentId: true,
      direction: true,
      leverage: true,
      quantity: true,
      status: true,
      executionType: true,
      triggerPrice: true,
      limitPrice: true,
      instrument: { select: FUTURES_INSTRUMENT_SELECT },
      limitOrder: { select: { id: true, status: true } },
      execution: { select: { id: true } },
    },
  });
  if (!row) return null;
  const limitOrder = row.limitOrder;
  return {
    type: 'futures_conditional_entry',
    id: row.id,
    domain: 'futures',
    link: { futuresConditionalEntryId: row.id },
    assetId: row.instrument.underlyingAsset.id,
    asset: row.instrument.underlyingAsset,
    instrumentId: row.instrumentId,
    direction: row.direction,
    state:
      row.status === 'watching' || row.status === 'triggered'
        ? 'open'
        : row.status === 'ordered' && limitOrder?.status === 'submitted'
          ? 'open'
          : row.status === 'ordered' &&
              (row.execution || limitOrder?.status === 'executed')
            ? 'filled'
            : 'ended',
    supported: true,
    executionType: row.executionType,
    entryPrice: row.limitPrice ?? row.triggerPrice,
    triggerPrice: row.triggerPrice,
    limitPrice: row.limitPrice,
    expectedQuantity: row.quantity,
    amount: null,
    currencyCode: 'USD',
    leverage: row.leverage,
    legacyProtection: false,
    childOrderId: limitOrder?.id ?? null,
  };
}

/** The plans of one entry (any status), oldest first. */
export function entryPlanWhere(root: Pick<EntryRoot, 'link'>) {
  return root.link as Prisma.EntryTpSlPlanWhereInput;
}

/**
 * Registers plans on an open entry. Caller holds the account fence and has
 * resolved `root` with `lock`. Plans reserve nothing and never trigger; the
 * entry's fill activates them. All-or-nothing.
 */
export async function createEntryTpSlPlansInTransaction(
  tx: Client,
  input: {
    accountId: string;
    root: EntryRoot;
    intents: EntryTpSlIntent[];
    idempotencyKey: (index: number) => string;
    requestHash: string;
    now: Date;
  },
) {
  const { root } = input;
  if (!root.supported)
    throw createApiError(
      'ENTRY_TP_SL_ENTRY_UNSUPPORTED',
      'Stop-loss and take-profit plans attach to a pending BUY limit, conditional BUY or Futures entry.',
      409,
    );
  if (root.state === 'filled')
    throw createApiError(
      'ENTRY_TP_SL_ENTRY_FILLED',
      'The entry already filled; set stop-loss and take-profit on the holding or position.',
      409,
    );
  if (root.state !== 'open')
    throw createApiError(
      'ENTRY_TP_SL_ENTRY_NOT_OPEN',
      'The entry is no longer pending.',
      409,
    );
  if (root.domain === 'spot' && root.asset.assetType === 'us_stock')
    throw createApiError(
      'ENTRY_TP_SL_MARKET_NOT_SUPPORTED',
      'Stop-loss and take-profit settings are available for Korean stocks and crypto.',
      409,
    );
  // A legacy OCO attachment will own the whole future holding.
  if (root.legacyProtection)
    throw createApiError(
      'PROTECTION_CONFLICT',
      'Cancel the attached TP/SL protection before adding stop-loss or take-profit plans.',
      409,
    );
  const pendingCount = await tx.entryTpSlPlan.count({
    where: { tradingAccountId: input.accountId, ...pendingEntryTpSl },
  });
  const pending = await tx.entryTpSlPlan.findMany({
    where: { ...entryPlanWhere(root), ...pendingEntryTpSl },
    select: { kind: true, triggerPrice: true, ratioPercent: true },
  });
  if (
    pendingCount + input.intents.length > ENTRY_TP_SL_MAX_PENDING_PER_ACCOUNT ||
    pending.length + input.intents.length > ENTRY_TP_SL_MAX_PER_ENTRY
  )
    throw createApiError(
      'ENTRY_TP_SL_LIMIT_EXCEEDED',
      'Too many pending stop-loss and take-profit plans.',
      409,
    );
  const conflict = findEntryPlanConflict({ intents: input.intents, pending });
  if (conflict === 'duplicate_price')
    throw createApiError(
      'ENTRY_TP_SL_DUPLICATE_PRICE',
      'A pending plan of the same kind already uses this price.',
      409,
    );
  if (conflict === 'total_exceeds_entry')
    throw createApiError(
      'ENTRY_TP_SL_TOTAL_EXCEEDS_ENTRY',
      'Plans of the same kind would exceed the entry quantity.',
      409,
    );
  assertEntryTriggerSides(input.intents, root.direction, root.entryPrice);
  const rows: EntryTpSlPlan[] = [];
  for (const [index, intent] of input.intents.entries())
    rows.push(
      await tx.entryTpSlPlan.create({
        data: {
          tradingAccountId: input.accountId,
          domain: root.domain,
          assetId: root.assetId,
          ...root.link,
          kind: intent.kind,
          triggerPrice: intent.triggerPrice,
          ratioPercent: intent.ratioPercent,
          idempotencyKey: input.idempotencyKey(index),
          requestHash: input.requestHash,
          createdAt: input.now,
        },
      }),
    );
  return rows;
}

type PlanRow = {
  id: string;
  kind: 'stop_loss' | 'take_profit';
  triggerPrice: Prisma.Decimal;
  ratioPercent: number;
};

/**
 * Same transaction as a Spot BUY that executed (market, including a one-shot
 * ERS partial, or a limit fill): the pending plans of THIS order — attached
 * to it, or to the conditional BUY that created it — become independent
 * stop-loss/take-profit settings on the holding for ratioPercent of the
 * quantity this order actually executed (never the earlier holding, never
 * another order's fill). A plan that the holding rules would refuse now
 * (a live OCO group, the per-kind total, a duplicate live price, the
 * account cap) ends `failed` with the reason; nothing larger is created.
 */
export async function activateSpotEntryTpSlPlans(
  tx: Client,
  input: {
    accountId: string;
    assetId: string;
    orderId: string;
    executedQuantity: Prisma.Decimal;
    now: Date;
  },
) {
  const plans = await tx.entryTpSlPlan.findMany({
    where: {
      tradingAccountId: input.accountId,
      domain: 'spot',
      ...pendingEntryTpSl,
      OR: [
        { orderId: input.orderId },
        { conditionalBuyOrder: { is: { orderId: input.orderId } } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, triggerPrice: true, ratioPercent: true },
  });
  if (!plans.length) return 0;
  const executed = input.executedQuantity;
  const position = await tx.position.findUnique({
    where: {
      tradingAccountId_assetId: {
        tradingAccountId: input.accountId,
        assetId: input.assetId,
      },
    },
    select: { id: true, quantity: true },
  });
  const asset = await tx.asset.findUniqueOrThrow({
    where: { id: input.assetId },
    select: { settlementCurrency: true },
  });
  const oco = await tx.protectionGroup.count({
    where: {
      tradingAccountId: input.accountId,
      assetId: input.assetId,
      domain: 'spot',
      ...liveProtection,
    },
  });
  let liveCount = await tx.conditionalSellOrder.count({
    where: { tradingAccountId: input.accountId, ...liveConditionalSell },
  });
  const live = position
    ? await tx.conditionalSellOrder.findMany({
        where: {
          tradingAccountId: input.accountId,
          assetId: input.assetId,
          positionId: position.id,
          kind: { in: ['stop_loss', 'take_profit'] },
          ...liveConditionalSell,
        },
        select: { kind: true, triggerPrice: true, quantity: true },
      })
    : [];
  let activated = 0;
  for (const plan of plans) {
    const target = entryPlanTargetQuantity(
      executed,
      plan.ratioPercent,
      orderInputQuantityScale,
    );
    const failure =
      !position || position.quantity.lte(0) || executed.lte(0)
        ? 'ENTRY_TP_SL_POSITION_UNAVAILABLE'
        : oco
          ? 'PROTECTION_CONFLICT'
          : target.lte(0)
            ? 'ENTRY_TP_SL_QUANTITY_TOO_SMALL'
            : liveCount + 1 > CONDITIONAL_SELL_MAX_LIVE_PER_ACCOUNT
              ? 'CONDITIONAL_SELL_LIMIT_EXCEEDED'
              : settingConflictCode(
                  findProtectionSettingConflict({
                    intents: [{ ...plan, quantity: target }],
                    live,
                    holding: position.quantity,
                  }),
                );
    if (failure) {
      await failPlan(tx, plan, failure, input.now, {
        basisQuantity: executed,
        fillOrderId: input.orderId,
      });
      continue;
    }
    const setting = await tx.conditionalSellOrder.create({
      data: {
        tradingAccountId: input.accountId,
        assetId: input.assetId,
        positionId: position!.id,
        kind: plan.kind,
        triggerCondition:
          plan.kind === 'stop_loss' ? 'at_or_below' : 'at_or_above',
        triggerPrice: plan.triggerPrice,
        executionType: 'market',
        limitPrice: null,
        quantity: target,
        currencyCode: asset.settlementCurrency,
        idempotencyKey: `entry-plan:${plan.id}`,
        requestHash: activationHash(plan.id),
        createdAt: input.now,
      },
      select: { id: true },
    });
    await tx.entryTpSlPlan.update({
      where: { id: plan.id },
      data: {
        status: 'activated',
        basisQuantity: executed,
        activatedQuantity: target,
        fillOrderId: input.orderId,
        conditionalSellOrderId: setting.id,
        endedAt: input.now,
      },
    });
    live.push({
      kind: plan.kind,
      triggerPrice: plan.triggerPrice,
      quantity: target,
    });
    liveCount += 1;
    activated += 1;
  }
  return activated;
}

/**
 * Same transaction as the Futures execution that opened a new lifetime from a
 * pending entry (a filled limit entry, or a conditional entry's market open):
 * its pending plans become independent settings on that lifetime for
 * ratioPercent of the executed quantity (8 decimals, cut down).
 */
export async function activateFuturesEntryTpSlPlans(
  tx: Client,
  input: {
    accountId: string;
    position: {
      id: string;
      instrumentId: string;
      direction: FuturesDirection;
      quantity: Prisma.Decimal;
    };
    executionId: string;
    executedQuantity: Prisma.Decimal;
    entry: { limitOrderId: string } | { conditionalEntryId: string };
    now: Date;
  },
) {
  const plans = await tx.entryTpSlPlan.findMany({
    where: {
      tradingAccountId: input.accountId,
      domain: 'futures',
      ...pendingEntryTpSl,
      ...('limitOrderId' in input.entry
        ? {
            OR: [
              { futuresLimitOrderId: input.entry.limitOrderId },
              {
                futuresConditionalEntry: {
                  is: { limitOrderId: input.entry.limitOrderId },
                },
              },
            ],
          }
        : { futuresConditionalEntryId: input.entry.conditionalEntryId }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, triggerPrice: true, ratioPercent: true },
  });
  if (!plans.length) return 0;
  const executed = input.executedQuantity;
  const oco = await tx.protectionGroup.count({
    where: { futuresPositionId: input.position.id, ...liveProtection },
  });
  let liveCount = await tx.futuresTpSlSetting.count({
    where: { tradingAccountId: input.accountId, ...liveFuturesTpSl },
  });
  const live = await tx.futuresTpSlSetting.findMany({
    where: { positionId: input.position.id, ...liveFuturesTpSl },
    select: { kind: true, triggerPrice: true, quantity: true },
  });
  let activated = 0;
  for (const plan of plans) {
    const target = entryPlanTargetQuantity(executed, plan.ratioPercent, 8);
    const failure =
      input.position.quantity.lte(0) || executed.lte(0)
        ? 'ENTRY_TP_SL_POSITION_UNAVAILABLE'
        : oco
          ? 'PROTECTION_CONFLICT'
          : target.lte(0)
            ? 'ENTRY_TP_SL_QUANTITY_TOO_SMALL'
            : liveCount + 1 > FUTURES_TP_SL_MAX_LIVE_PER_ACCOUNT
              ? 'FUTURES_TP_SL_LIMIT_EXCEEDED'
              : settingConflictCode(
                  findProtectionSettingConflict({
                    intents: [{ ...plan, quantity: target }],
                    live,
                    holding: input.position.quantity,
                  }),
                );
    if (failure) {
      await failPlan(tx, plan, failure, input.now, {
        basisQuantity: executed,
        fillExecutionId: input.executionId,
      });
      continue;
    }
    const setting = await tx.futuresTpSlSetting.create({
      data: {
        tradingAccountId: input.accountId,
        instrumentId: input.position.instrumentId,
        positionId: input.position.id,
        direction: input.position.direction,
        kind: plan.kind,
        triggerPrice: plan.triggerPrice,
        quantity: target,
        idempotencyKey: `entry-plan:${plan.id}`,
        requestHash: activationHash(plan.id),
        createdAt: input.now,
      },
      select: { id: true },
    });
    await tx.entryTpSlPlan.update({
      where: { id: plan.id },
      data: {
        status: 'activated',
        basisQuantity: executed,
        activatedQuantity: target,
        fillExecutionId: input.executionId,
        futuresTpSlSettingId: setting.id,
        endedAt: input.now,
      },
    });
    live.push({
      kind: plan.kind,
      triggerPrice: plan.triggerPrice,
      quantity: target,
    });
    liveCount += 1;
    activated += 1;
  }
  return activated;
}

/**
 * Same transaction as a Spot limit order's cancel or lifecycle release: the
 * pending plans of that order — attached to it, or to the conditional BUY that
 * created it — end with it. Nothing was reserved for them.
 */
export async function endEntryTpSlPlansForSpotOrder(
  tx: Client,
  orderId: string,
  now: Date,
) {
  const result = await tx.entryTpSlPlan.updateMany({
    where: {
      ...pendingEntryTpSl,
      OR: [{ orderId }, { conditionalBuyOrder: { is: { orderId } } }],
    },
    data: {
      status: 'canceled',
      terminalReason: 'entry_canceled',
      endedAt: now,
    },
  });
  return result.count;
}

/** Same as above for a Futures limit entry's cancel or lifecycle release. */
export async function endEntryTpSlPlansForFuturesLimitOrder(
  tx: Client,
  limitOrderId: string,
  now: Date,
) {
  const result = await tx.entryTpSlPlan.updateMany({
    where: {
      ...pendingEntryTpSl,
      OR: [
        { futuresLimitOrderId: limitOrderId },
        { futuresConditionalEntry: { is: { limitOrderId } } },
      ],
    },
    data: {
      status: 'canceled',
      terminalReason: 'entry_canceled',
      endedAt: now,
    },
  });
  return result.count;
}

/**
 * Ends the pending plans of entries that can no longer fill: a canceled or
 * failed conditional entry, a conditional entry whose order was canceled or
 * rejected, a canceled or rejected limit order. Called in the transactions
 * that end conditional entries (user cancel, lifecycle, failure), and as the
 * worker's bounded safety net (`accountId` null). An ended entry never
 * reopens, so this is monotonic and safe without further locks; a filled
 * entry is never touched (its fill transaction activated its plans).
 */
export async function endEntryTpSlPlansOfEndedEntries(
  tx: Pick<Client, 'entryTpSlPlan'>,
  accountId: string | null,
  now: Date,
) {
  const scope = accountId ? { tradingAccountId: accountId } : {};
  const endedOrder = {
    is: { status: { in: ['canceled', 'rejected'] as OrderStatus[] } },
  };
  const rules: Array<[Prisma.EntryTpSlPlanWhereInput, string]> = [
    [{ order: endedOrder }, 'entry_canceled'],
    [{ conditionalBuyOrder: { is: { status: 'canceled' } } }, 'entry_canceled'],
    [{ conditionalBuyOrder: { is: { status: 'failed' } } }, 'entry_failed'],
    [
      { conditionalBuyOrder: { is: { status: 'ordered', order: endedOrder } } },
      'entry_canceled',
    ],
    [{ futuresLimitOrder: endedOrder }, 'entry_canceled'],
    [
      { futuresConditionalEntry: { is: { status: 'canceled' } } },
      'entry_canceled',
    ],
    [{ futuresConditionalEntry: { is: { status: 'failed' } } }, 'entry_failed'],
    [
      {
        futuresConditionalEntry: {
          is: { status: 'ordered', limitOrder: endedOrder },
        },
      },
      'entry_canceled',
    ],
  ];
  let count = 0;
  // Sequential: one transaction connection.
  for (const [where, reason] of rules)
    count += (
      await tx.entryTpSlPlan.updateMany({
        where: { ...scope, ...pendingEntryTpSl, ...where },
        data: { status: 'canceled', terminalReason: reason, endedAt: now },
      })
    ).count;
  return count;
}

async function failPlan(
  tx: Client,
  plan: PlanRow,
  code: string,
  now: Date,
  evidence: {
    basisQuantity: Prisma.Decimal;
    fillOrderId?: string;
    fillExecutionId?: string;
  },
) {
  await tx.entryTpSlPlan.update({
    where: { id: plan.id },
    data: {
      status: 'failed',
      terminalReason: 'activation_failed',
      failureCode: code,
      basisQuantity: evidence.basisQuantity.gt(0)
        ? evidence.basisQuantity
        : null,
      fillOrderId: evidence.fillOrderId ?? null,
      fillExecutionId: evidence.fillExecutionId ?? null,
      endedAt: now,
    },
  });
}

function settingConflictCode(
  conflict: 'duplicate_price' | 'total_exceeds_holding' | null,
) {
  return conflict === 'duplicate_price'
    ? 'ENTRY_TP_SL_DUPLICATE_PRICE'
    : conflict === 'total_exceeds_holding'
      ? 'ENTRY_TP_SL_TOTAL_EXCEEDS_HOLDING'
      : null;
}

function activationHash(planId: string) {
  return conditionalHash({ operation: 'entry_tp_sl_activation', planId });
}
