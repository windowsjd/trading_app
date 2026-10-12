import { createApiError } from '../common/api-error';
import { Prisma } from '../generated/prisma/client';

/** Watching or triggered-but-not-yet-ordered. Nothing else can act. */
export const liveConditionalBuy = {
  status: { in: ['watching', 'triggered'] as ('watching' | 'triggered')[] },
};

export type ConditionalBuyLifecycleReason =
  | 'user_canceled'
  | 'season_ended'
  | 'participant_excluded'
  | 'account_not_tradable'
  | 'asset_not_tradable';

/** Caller holds the account/lifecycle fence. Watches reserve nothing. */
export async function cancelLiveConditionalBuysInTransaction(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  reason: ConditionalBuyLifecycleReason,
  now: Date,
) {
  const result = await tx.conditionalBuyOrder.updateMany({
    where: { tradingAccountId, ...liveConditionalBuy },
    data: { status: 'canceled', terminalReason: reason, endedAt: now },
  });
  return result.count;
}

export type ConditionalBuyOrderIntent = {
  assetId: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  limitPrice: Prisma.Decimal | null;
};

/**
 * Internal worker capability inside the ordinary order create transaction,
 * after the account/lifecycle fence: the watch must still be triggered and
 * the request must be exactly the registered intent. A concurrent user cancel
 * either committed first (this create fails) or waits behind this lock.
 */
export async function lockTriggeredConditionalBuy(
  tx: Prisma.TransactionClient,
  id: string,
  tradingAccountId: string,
  request: ConditionalBuyOrderIntent,
) {
  await tx.$queryRaw`SELECT "id" FROM "conditional_buy_orders" WHERE "id" = ${id} AND "trading_account_id" = ${tradingAccountId} FOR UPDATE`;
  const row = await tx.conditionalBuyOrder.findFirst({
    where: { id, tradingAccountId },
  });
  if (
    !row ||
    row.status !== 'triggered' ||
    row.orderId !== null ||
    row.assetId !== request.assetId ||
    request.side !== 'buy' ||
    row.executionType !== request.orderType ||
    !sameDecimal(row.quantity, request.quantity) ||
    !sameDecimal(row.amount, request.amount) ||
    !sameDecimal(row.limitPrice, request.limitPrice)
  )
    throw createApiError(
      'CONDITIONAL_BUY_CHANGED',
      'The conditional order changed before execution.',
      409,
    );
  return row;
}

/** Same transaction as the Order insert; the Order is the settlement record. */
export async function linkConditionalBuyOrder(
  tx: Prisma.TransactionClient,
  id: string,
  tradingAccountId: string,
  orderId: string,
  now: Date,
) {
  const linked = await tx.conditionalBuyOrder.updateMany({
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
      'CONDITIONAL_BUY_CHANGED',
      'The conditional order changed before execution.',
      409,
    );
}

function sameDecimal(a: Prisma.Decimal | null, b: Prisma.Decimal | null) {
  return a === null || b === null ? a === b : a.eq(b);
}
