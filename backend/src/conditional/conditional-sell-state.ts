import { createApiError } from '../common/api-error';
import { Prisma } from '../generated/prisma/client';
import { conditionalSellWindowExpired } from './conditional-sell-policy';
import { liveProtection } from './conditional-state';

/** Watching or triggered-but-not-yet-ordered. Nothing else can act. */
export const liveConditionalSell = {
  status: { in: ['watching', 'triggered'] as ('watching' | 'triggered')[] },
};

/**
 * Read filter `state=open`: everything the owner can still cancel — a live
 * intent, or one whose linked limit Order is still `submitted` (API state
 * `order_pending`, canceled through the ordinary order cancel). `state=ended`
 * is its complement; ended rows never become open again.
 */
export const openConditionalSell: Prisma.ConditionalSellOrderWhereInput = {
  OR: [
    liveConditionalSell,
    { status: 'ordered', order: { is: { status: 'submitted' } } },
  ],
};

export type ConditionalSellLifecycleReason =
  | 'user_canceled'
  | 'season_ended'
  | 'participant_excluded'
  | 'account_not_tradable'
  | 'asset_not_tradable'
  | 'position_closed';

/** Caller holds the account/lifecycle fence. Intents reserve nothing. */
export async function cancelLiveConditionalSellsInTransaction(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  reason: ConditionalSellLifecycleReason,
  now: Date,
) {
  const result = await tx.conditionalSellOrder.updateMany({
    where: { tradingAccountId, ...liveConditionalSell },
    data: { status: 'canceled', terminalReason: reason, endedAt: now },
  });
  return result.count;
}

/**
 * Same transaction as an executed SELL (market or limit fill): when it left
 * the position flat, every live intent on it ends now, so a later re-buy of
 * the asset never inherits an earlier holding's intents. A linked order is
 * unaffected (it already owns its reservation or executed).
 */
export async function closeConditionalSellsOnFlatPosition(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  assetId: string,
  now: Date,
) {
  // One statement: the holding row the intents belong to is read inside it.
  const result = await tx.conditionalSellOrder.updateMany({
    where: {
      tradingAccountId,
      assetId,
      ...liveConditionalSell,
      position: { is: { quantity: { lte: 0 } } },
    },
    data: {
      status: 'canceled',
      terminalReason: 'position_closed',
      endedAt: now,
    },
  });
  return result.count;
}

/** Live intents on one holding (OCO registration conflict). */
export function countLiveConditionalSells(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  assetId: string,
) {
  return tx.conditionalSellOrder.count({
    where: { tradingAccountId, assetId, ...liveConditionalSell },
  });
}

export type ConditionalSellOrderIntent = {
  assetId: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  limitPrice: Prisma.Decimal | null;
};

/**
 * Internal worker capability inside the ordinary order create transaction,
 * after the account/lifecycle fence and BEFORE any protection preparation:
 * the intent must still be triggered and unlinked, the request must be its
 * registered SELL (price, execution type, a quantity no larger than the
 * target), no whole-position OCO protection may own the holding, and the
 * 30 s window must still be open at the DB clock after this lock. A
 * concurrent user cancel or flat-position close either committed first (this
 * create fails) or waits behind the account fence.
 */
export async function lockTriggeredConditionalSell(
  tx: Prisma.TransactionClient,
  id: string,
  tradingAccountId: string,
  request: ConditionalSellOrderIntent,
) {
  await tx.$queryRaw`SELECT "id" FROM "conditional_sell_orders" WHERE "id" = ${id} AND "trading_account_id" = ${tradingAccountId} FOR UPDATE`;
  const row = await tx.conditionalSellOrder.findFirst({
    where: { id, tradingAccountId },
  });
  if (
    !row ||
    row.status !== 'triggered' ||
    row.orderId !== null ||
    row.assetId !== request.assetId ||
    request.side !== 'sell' ||
    row.executionType !== request.orderType ||
    request.amount !== null ||
    !request.quantity ||
    request.quantity.lte(0) ||
    request.quantity.gt(row.quantity) ||
    !sameDecimal(row.limitPrice, request.limitPrice)
  )
    throw createApiError(
      'CONDITIONAL_SELL_CHANGED',
      'The conditional order changed before execution.',
      409,
    );
  const protection = await tx.protectionGroup.count({
    where: {
      tradingAccountId,
      assetId: row.assetId,
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
  await assertConditionalSellExecutionWindow(tx, row.triggeredAt);
  return row;
}

/**
 * The execution window at the create transaction's DB clock. Checked after
 * the intent lock and again as the transaction's last statement, so neither
 * a slow quote nor a lock wait during the writes turns a trigger 30 s old or
 * older into an order. A committed create replays before either check.
 */
export async function assertConditionalSellExecutionWindow(
  tx: Prisma.TransactionClient,
  triggeredAt: Date | null,
) {
  const [{ now }] = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS "now"`;
  if (!triggeredAt || conditionalSellWindowExpired(triggeredAt, now))
    throw createApiError(
      'CONDITIONAL_SELL_EXECUTION_WINDOW_EXPIRED',
      'The conditional order trigger is too old to execute.',
      409,
    );
}

/** Same transaction as the Order insert; the Order is the settlement record. */
export async function linkConditionalSellOrder(
  tx: Prisma.TransactionClient,
  id: string,
  tradingAccountId: string,
  orderId: string,
  now: Date,
) {
  const linked = await tx.conditionalSellOrder.updateMany({
    where: { id, tradingAccountId, status: 'triggered', orderId: null },
    data: {
      status: 'ordered',
      orderId,
      endedAt: now,
      lastAttemptAt: now,
      attemptCount: { increment: 1 },
      failureCode: null,
    },
  });
  if (linked.count !== 1)
    throw createApiError(
      'CONDITIONAL_SELL_CHANGED',
      'The conditional order changed before execution.',
      409,
    );
}

function sameDecimal(a: Prisma.Decimal | null, b: Prisma.Decimal | null) {
  return a === null || b === null ? a === b : a.eq(b);
}
