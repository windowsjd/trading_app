// Pure order-status helpers for the order history list. Kept free of any
// api-client import chain so they run under `node --test`.

export const ORDER_STATUS_LABEL: Record<string, string> = {
  submitted: '미체결',
  executed: '체결',
  canceled: '취소',
  rejected: '거부',
};

export type OrderStatusFields = {
  orderType?: string | null;
  side?: string | null;
  status?: string | null;
};

/** True for an unfilled limit-buy order the user can still cancel. */
export function isOpenLimitBuyOrder(item: OrderStatusFields): boolean {
  return (
    item.orderType === 'limit' &&
    item.side === 'buy' &&
    item.status === 'submitted'
  );
}

/**
 * True when the row has no execution behind it, so grossAmount / feeAmount /
 * netAmount / executedPrice must not be rendered as its amounts.
 *
 * Covers submitted AND canceled limit orders: phase 1 has no matching engine,
 * so neither state ever produced a fill. A canceled row keeps its
 * reservedAmount as history — that is a reservation figure, not a fill.
 */
export function hasNoExecutionResult(item: OrderStatusFields): boolean {
  return (
    item.orderType === 'limit' &&
    (item.status === 'submitted' || item.status === 'canceled')
  );
}

export function getOrderStatusLabel(
  status?: string | null,
): string | null {
  if (!status) return null;
  return ORDER_STATUS_LABEL[status] ?? status;
}
