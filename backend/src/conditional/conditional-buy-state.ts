import { createApiError } from '../common/api-error';
import { Prisma } from '../generated/prisma/client';
import { conditionalBuyWindowExpired } from './conditional-buy-policy';
import { endEntryTpSlPlansOfEndedEntries } from './entry-tp-sl-state';

/** Watching or triggered-but-not-yet-ordered. Nothing else can act. */
export const liveConditionalBuy = {
  status: { in: ['watching', 'triggered'] as ('watching' | 'triggered')[] },
};

/**
 * Read filter `state=open`: everything the owner can still cancel — a live
 * watch, or a watch whose linked limit Order is still `submitted` (API state
 * `order_pending`, canceled through the ordinary order cancel). `state=ended`
 * is its complement; ended rows never become open again.
 */
export const openConditionalBuy: Prisma.ConditionalBuyOrderWhereInput = {
  OR: [
    liveConditionalBuy,
    { status: 'ordered', order: { is: { status: 'submitted' } } },
  ],
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
  // Their stop-loss/take-profit plans end with them.
  if (result.count)
    await endEntryTpSlPlansOfEndedEntries(tx, tradingAccountId, now);
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
 * after the account/lifecycle fence: the watch must still be triggered, the
 * request must be exactly the registered intent, and the 30 s window must
 * still be open at the DB clock after this lock. A concurrent user cancel
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
  await assertConditionalBuyExecutionWindow(tx, row.triggeredAt);
  return row;
}

/**
 * The execution window at the create transaction's DB clock. Checked after
 * the watch lock and again as the transaction's last statement, so neither a
 * slow quote nor a lock wait during the writes turns a trigger 30 s old or
 * older into an order. A committed create replays before either check.
 */
export async function assertConditionalBuyExecutionWindow(
  tx: Prisma.TransactionClient,
  triggeredAt: Date | null,
) {
  const [{ now }] = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS "now"`;
  if (!triggeredAt || conditionalBuyWindowExpired(triggeredAt, now))
    throw createApiError(
      'CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED',
      'The conditional order trigger is too old to execute.',
      409,
    );
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
