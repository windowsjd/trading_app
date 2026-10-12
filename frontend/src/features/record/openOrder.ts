import type { MarketExecutionDto } from '../order/api';
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

/** True for an unfilled limit order the user can still cancel. */
export function isOpenLimitOrder(item: OrderStatusFields): boolean {
  return item.orderType === 'limit' && item.status === 'submitted';
}

/** Backward-compatible export for existing callers; now covers both sides. */
export const isOpenLimitBuyOrder = isOpenLimitOrder;

export function shouldPollSubmittedLimitOrders(input: {
  isFocused: boolean;
  appState: string;
  items: readonly OrderStatusFields[];
}): boolean {
  return (
    input.isFocused &&
    input.appState === 'active' &&
    input.items.some(isOpenLimitOrder)
  );
}

/**
 * True when the row has no execution behind it, so grossAmount / feeAmount /
 * netAmount / executedPrice must not be rendered as its amounts.
 *
 * Covers submitted AND canceled limit orders: neither state represents a
 * completed fill. A canceled row keeps its reservedAmount as history — that
 * is a reservation figure, not a fill.
 */
export function hasNoExecutionResult(item: OrderStatusFields): boolean {
  return (
    item.orderType === 'limit' &&
    (item.status === 'submitted' || item.status === 'canceled')
  );
}

/** The server-owned LOC state a row may carry (see LimitOnCloseOrderDto). */
export type LimitOnCloseFields = {
  status?: string | null;
  sessionDate?: string | null;
  decisionReason?: string | null;
};

/** 시장가/지정가/LOC with the side; LOC is a limit order bound to a close. */
export function getOrderTypeLabel(item: OrderStatusFields & { limitOnClose?: LimitOnCloseFields | null }) {
  const side = item.side === 'sell' ? '매도' : '매수';
  if (item.limitOnClose) return `LOC ${side}`;
  return item.orderType === 'limit' ? `지정가 ${side}` : side;
}

/**
 * A LOC row's own outcome. Acceptance is never a fill: `pending` waits for the
 * confirmed close, and only an executed order reads as 체결.
 */
export function getLimitOnCloseStatusLabel(loc: LimitOnCloseFields, orderStatus?: string | null): string {
  if (orderStatus === 'executed' || loc.status === 'filled') return '체결 (확정 종가)';
  switch (loc.status) {
    case 'pending':
      return '종가 판정 대기';
    case 'unfilled':
      return '미체결 종료 · 예약 해제';
    case 'expired':
      return '판정 기한 만료 · 예약 해제';
    case 'canceled':
      return '취소';
    default:
      return orderStatus ? ORDER_STATUS_LABEL[orderStatus] ?? orderStatus : '상태 확인 필요';
  }
}

export function getOrderStatusLabel(status?: string | null, execution?: MarketExecutionDto | null): string | null {
  if (status === 'executed' && execution?.status === 'partial') return '부분체결 · 잔량 자동취소';
  if (!status) return null;
  return ORDER_STATUS_LABEL[status] ?? status;
}
