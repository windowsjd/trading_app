import type { FuturesConditionalEntry } from './api';

/**
 * Display copy for Futures conditional entries. Pure module (node --test).
 * The watch state never reads as a fill: `filled` comes only from the created
 * execution or an executed limit entry.
 */
export function getFuturesConditionalStateLabel(entry: Pick<FuturesConditionalEntry, 'state' | 'executionType' | 'terminalReason'>) {
  switch (entry.state) {
    case 'watching': return '감시 중';
    case 'triggered': return '발동 · 주문 생성 중';
    case 'order_pending': return '발동 · 지정가 주문 대기';
    case 'filled': return entry.executionType === 'market' ? '발동 · 시장가 체결' : '발동 · 지정가 체결';
    case 'order_canceled': return '발동 · 지정가 주문 취소';
    case 'order_rejected': return '발동 · 주문 거부';
    case 'failed': return '발동 후 주문 실패';
    case 'canceled': return entry.terminalReason === 'user_canceled' ? '사용자 취소' : '정책에 따라 종료';
  }
}

const END_REASON: Record<string, string> = {
  user_canceled: '직접 취소했습니다.',
  season_ended: '시즌이 종료되어 감시를 끝냈습니다.',
  participant_excluded: '시즌 참가가 제외되어 감시를 끝냈습니다.',
  account_not_tradable: '계정을 거래할 수 없는 상태가 되어 감시를 끝냈습니다.',
  instrument_not_tradable: '상품 거래가 중지되어 감시를 끝냈습니다.',
  execution_window_expired: '발동 후 30초 안에 주문을 만들지 못했습니다.',
};

const FAILURE: Record<string, string> = {
  INSUFFICIENT_FUTURES_FREE_COLLATERAL: '사용 가능한 선물 담보가 부족했습니다.',
  FUTURES_MAINTENANCE_UNSAFE: '유지 증거금 기준을 충족하지 못했습니다.',
  FUTURES_POSITION_ALREADY_OPEN: '같은 상품에 보유 포지션이 있었습니다.',
  FUTURES_ENTRY_PENDING: '같은 상품에 대기 중인 지정가 진입이 있었습니다.',
  FUTURES_REDUCE_ONLY: '선물 신규 진입이 제한된 상태였습니다.',
  FUTURES_TRADING_DISABLED: '선물 거래가 비활성 상태였습니다.',
  FUTURES_INSTRUMENT_UNVERIFIED: '상품이 신규 진입 가능한 상태가 아니었습니다.',
  FUTURES_PRICE_UNAVAILABLE: '선물 Last 시세를 확인할 수 없었습니다.',
  FUTURES_PRICE_STALE: '선물 Last 시세를 확인할 수 없었습니다.',
  FUTURES_MARK_UNAVAILABLE: 'Mark 시세를 확인할 수 없었습니다.',
  FUTURES_MARK_STALE: 'Mark 시세를 확인할 수 없었습니다.',
};

/** A Futures execution refusal in words (conditional entry or TP/SL); null if unknown. */
export function getFuturesFailureText(code: string | null | undefined) {
  return (code && FAILURE[code]) || null;
}

/** Why a row ended, in words; null while it is still open. */
export function getFuturesConditionalEndReason(entry: Pick<FuturesConditionalEntry, 'state' | 'terminalReason' | 'failureCode'>) {
  if (entry.state === 'failed')
    return entry.terminalReason === 'execution_window_expired'
      ? END_REASON.execution_window_expired
      : (entry.failureCode && FAILURE[entry.failureCode]) ?? '주문을 실행하지 못했습니다.';
  if (entry.state === 'canceled') return (entry.terminalReason && END_REASON[entry.terminalReason]) ?? '감시를 끝냈습니다.';
  return null;
}

/** What 취소 does for this row: the watch, its created limit entry, or nothing. */
export function getFuturesConditionalCancelPath(entry: Pick<FuturesConditionalEntry, 'state' | 'limitOrder'>):
  { kind: 'entry' } | { kind: 'limit'; orderId: string } | null {
  if (entry.state === 'watching' || entry.state === 'triggered') return { kind: 'entry' };
  if (entry.state === 'order_pending' && entry.limitOrder?.status === 'submitted')
    return { kind: 'limit', orderId: entry.limitOrder.orderId };
  return null;
}

export const FUTURES_CONDITION_SIGN = { at_or_above: '≥', at_or_below: '≤' } as const;
