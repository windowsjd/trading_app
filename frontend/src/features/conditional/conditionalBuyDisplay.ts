import type {
  ConditionalBuyExecutionType,
  ConditionalBuyOrderDto,
  ConditionalBuyState,
  ConditionalBuyTriggerCondition,
} from './conditionalBuyApi';

/**
 * Pure display/validation rules for Conditional BUY (kept free of the API
 * client so they run under `node --test`). Every label keeps "condition met"
 * apart from "filled": only the linked order's execution is a fill.
 */
export const CONDITIONAL_BUY_STATE_LABEL: Record<ConditionalBuyState, string> = {
  watching: '감시 중',
  triggered: '조건 충족 · 주문 처리 중',
  order_pending: '주문 접수 · 체결 대기',
  filled: '체결 완료',
  canceled: '감시 취소',
  failed: '실행 실패',
  order_canceled: '연결 주문 취소',
  order_rejected: '연결 주문 거부',
};

export function getConditionalBuyStateLabel(state: string) {
  return CONDITIONAL_BUY_STATE_LABEL[state as ConditionalBuyState] ?? '상태 확인 필요';
}

export const TRIGGER_CONDITION_LABEL: Record<ConditionalBuyTriggerCondition, string> = {
  at_or_above: '이상 도달',
  at_or_below: '이하 도달',
};

export const EXECUTION_TYPE_LABEL: Record<ConditionalBuyExecutionType, string> = {
  market: '시장가',
  limit: '지정가',
};

export function isLiveConditionalBuy(row: Pick<ConditionalBuyOrderDto, 'state'>) {
  return row.state === 'watching' || row.state === 'triggered';
}

/**
 * Which cancel applies now: the watch itself while nothing was ordered, the
 * ordinary order cancel once its linked limit order is pending, otherwise none
 * (filled, canceled, failed rows are read-only).
 */
export function getConditionalBuyCancelPath(
  row: Pick<ConditionalBuyOrderDto, 'state' | 'order'>,
): { kind: 'conditional' } | { kind: 'order'; orderId: string } | null {
  if (row.state === 'watching' || row.state === 'triggered') return { kind: 'conditional' };
  if (row.state === 'order_pending' && row.order?.orderId && row.order.status === 'submitted')
    return { kind: 'order', orderId: row.order.orderId };
  return null;
}

const TERMINAL_REASON_LABEL: Record<string, string> = {
  user_canceled: '직접 취소했어요.',
  season_ended: '시즌 종료로 감시가 끝났어요.',
  participant_excluded: '시즌 참가 제외로 감시가 끝났어요.',
  account_not_tradable: '계정이 거래할 수 없는 상태라 감시가 끝났어요.',
  asset_not_tradable: '종목이 거래할 수 없는 상태라 감시가 끝났어요.',
  execution_window_expired: '조건 충족 후 30초 안에 주문을 만들지 못했어요.',
  execution_failed: '조건 충족 후 주문을 만들지 못했어요.',
};

const FAILURE_CODE_LABEL: Record<string, string> = {
  INSUFFICIENT_BALANCE: '발동 시점의 잔액이 부족했어요.',
  INSUFFICIENT_AVAILABLE_BALANCE: '발동 시점의 사용 가능 현금이 부족했어요.',
  MARKET_CLOSED: '발동 시점에 정규장이 아니었어요.',
  PRICE_STALE: '발동 시점에 신선한 시세를 확인하지 못했어요.',
  ASSET_PRICE_UNAVAILABLE: '발동 시점에 시세를 확인하지 못했어요.',
  FX_RATE_STALE: '발동 시점에 환율을 확인하지 못했어요.',
  FX_RATE_UNAVAILABLE: '발동 시점에 환율을 확인하지 못했어요.',
  CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED: '조건 충족 후 30초 안에 주문을 만들지 못했어요.',
  CONDITIONAL_BUY_CHANGED: '감시 내용이 바뀌어 주문하지 않았어요.',
  BEGINNER_FEATURE_LOCKED: '학습 단계 제한으로 주문하지 않았어요.',
  TRADING_ACCOUNT_NOT_ACTIVE: '계정이 거래할 수 없는 상태였어요.',
  SEASON_NOT_ACTIVE: '시즌이 진행 중이 아니었어요.',
};

/** A user-facing reason for a terminal row; never a raw server code. */
export function getConditionalBuyEndReason(
  row: Pick<ConditionalBuyOrderDto, 'state' | 'failureCode' | 'terminalReason' | 'order'>,
) {
  if (row.state === 'failed') {
    return (row.failureCode ? FAILURE_CODE_LABEL[row.failureCode] : undefined)
      ?? (row.terminalReason ? TERMINAL_REASON_LABEL[row.terminalReason] : undefined)
      ?? '조건 충족 후 주문을 만들지 못했어요.';
  }
  if (row.state === 'canceled')
    return (row.terminalReason ? TERMINAL_REASON_LABEL[row.terminalReason] : undefined) ?? '감시가 취소됐어요.';
  if (row.state === 'order_canceled')
    return row.order?.cancelReason === 'user_canceled' ? '연결된 지정가 주문을 취소했어요.' : '연결된 주문이 체결 없이 종료됐어요.';
  if (row.state === 'order_rejected') return '연결된 주문이 거부됐어요.';
  return null;
}

export type ConditionalBuyResultNotice = {
  title: string;
  detail: string | null;
  /** Where the user goes next: the open list or the ended history. */
  next: string;
  tone: 'success' | 'progress' | 'ended' | 'error';
};

const OPEN_NEXT = '아래 대기 목록의 조건주문에서 상태를 확인하고 취소할 수 있어요.';
const ENDED_NEXT = '아래 대기 목록의 조건주문 종료 이력에서 확인할 수 있어요.';

/**
 * The form's answer to a create, first or replayed with the same key. A
 * replay returns the watch as it is NOW, so the copy follows the server's
 * `state`: registered/watching, condition met, order accepted and an actual
 * fill stay four different sentences, and an ended row never reads 감시 중.
 */
export function getConditionalBuyResultNotice(
  row: Pick<ConditionalBuyOrderDto, 'state' | 'failureCode' | 'terminalReason' | 'order'>,
): ConditionalBuyResultNotice {
  switch (row.state) {
    case 'watching':
      return { title: '조건주문이 등록되었습니다. 감시 중입니다.', detail: null, next: OPEN_NEXT, tone: 'success' };
    case 'triggered':
      return { title: '조건이 충족되어 주문을 처리하고 있어요.', detail: '아직 체결된 것은 아니에요.', next: OPEN_NEXT, tone: 'progress' };
    case 'order_pending':
      return { title: '조건이 충족되어 지정가 매수가 접수됐어요. 체결을 기다리고 있어요.', detail: null, next: OPEN_NEXT, tone: 'progress' };
    case 'filled':
      return { title: '조건주문의 매수가 체결됐어요.', detail: null, next: ENDED_NEXT, tone: 'success' };
    case 'failed':
      return { title: '조건이 충족됐지만 주문을 실행하지 못했어요.', detail: getConditionalBuyEndReason(row), next: ENDED_NEXT, tone: 'error' };
    case 'canceled':
      return { title: '취소된 조건주문이에요.', detail: getConditionalBuyEndReason(row), next: ENDED_NEXT, tone: 'ended' };
    case 'order_canceled':
      return { title: '연결된 지정가 주문이 체결 없이 끝났어요.', detail: getConditionalBuyEndReason(row), next: ENDED_NEXT, tone: 'ended' };
    case 'order_rejected':
      return { title: '연결된 주문이 거부됐어요.', detail: null, next: ENDED_NEXT, tone: 'error' };
    default:
      return { title: '조건주문 상태를 확인하지 못했어요.', detail: null, next: '아래 대기 목록의 조건주문에서 상태를 확인해 주세요.', tone: 'ended' };
  }
}

const DECIMAL = (scale: number) => new RegExp(`^\\d{1,16}(?:\\.\\d{1,${scale}})?$`, 'u');

function positiveDecimal(value: string, scale: number) {
  const trimmed = value.trim();
  return DECIMAL(scale).test(trimmed) && Number(trimmed) > 0;
}

/** 이상/이하 is not part of the draft: it follows the watch price (autoDirection). */
export type ConditionalBuyDraft = {
  assetType: string | null | undefined;
  triggerPrice: string;
  executionType: ConditionalBuyExecutionType;
  limitPrice: string;
  /** Stocks: quantity. Crypto: fee-exclusive principal amount. */
  size: string;
};

/** Mirrors the server's input parser; the server still decides. */
export function getConditionalBuyDraftError(draft: ConditionalBuyDraft): string | null {
  if (!draft.triggerPrice.trim()) return '감시가격을 입력해주세요.';
  if (!positiveDecimal(draft.triggerPrice, 8)) return '감시가격은 0보다 큰 숫자와 소수점 이하 최대 8자리로 입력해주세요.';
  if (draft.executionType === 'limit') {
    if (!draft.limitPrice.trim()) return '발동 시 주문할 지정가격을 입력해주세요.';
    if (!positiveDecimal(draft.limitPrice, 8)) return '지정가격은 0보다 큰 숫자와 소수점 이하 최대 8자리로 입력해주세요.';
  }
  const crypto = draft.assetType === 'crypto';
  if (!draft.size.trim()) return crypto ? '매수 금액을 입력해주세요.' : '수량을 입력해주세요.';
  if (crypto) {
    if (!positiveDecimal(draft.size, 8)) return '매수 금액은 0보다 큰 숫자와 소수점 이하 최대 8자리로 입력해주세요.';
  } else {
    if (!positiveDecimal(draft.size, 6)) return '수량은 0보다 큰 숫자와 소수점 이하 최대 6자리로 입력해주세요.';
    if (draft.executionType === 'limit' && !/^\d+$/u.test(draft.size.trim()))
      return '지정가로 발동하는 주식 조건주문은 정수 수량만 가능합니다.';
  }
  return null;
}
