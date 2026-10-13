import type {
  ConditionalSellExecutionType,
  ConditionalSellKind,
  ConditionalSellOrderDto,
  ConditionalSellState,
  ConditionalSellTriggerCondition,
} from './conditionalSellApi';

/**
 * Pure display/validation rules for SELL intents (conditions, independent
 * stop-loss/take-profit), kept free of the API client so they run under
 * `node --test`. Every label keeps "price reached" apart from "filled", and
 * the user's target quantity apart from what was really ordered or filled.
 */
export const CONDITIONAL_SELL_KIND_LABEL: Record<ConditionalSellKind, string> = {
  condition: '조건주문',
  stop_loss: '손절',
  take_profit: '익절',
};

export const CONDITIONAL_SELL_STATE_LABEL: Record<ConditionalSellState, string> = {
  watching: '감시 중',
  triggered: '조건 충족 · 주문 처리 중',
  order_pending: '매도 접수 · 체결 대기',
  filled: '체결 완료',
  canceled: '감시 종료',
  failed: '실행 실패',
  order_canceled: '연결 주문 취소',
  order_rejected: '연결 주문 거부',
};

export function getConditionalSellStateLabel(state: string) {
  return CONDITIONAL_SELL_STATE_LABEL[state as ConditionalSellState] ?? '상태 확인 필요';
}

export function getConditionalSellKindLabel(kind: string) {
  return CONDITIONAL_SELL_KIND_LABEL[kind as ConditionalSellKind] ?? '매도 설정';
}

export const SELL_TRIGGER_CONDITION_LABEL: Record<ConditionalSellTriggerCondition, string> = {
  at_or_above: '이상 도달',
  at_or_below: '이하 도달',
};

export const SELL_EXECUTION_TYPE_LABEL: Record<ConditionalSellExecutionType, string> = {
  market: '시장가',
  limit: '지정가',
};

export function isLiveConditionalSell(row: Pick<ConditionalSellOrderDto, 'state'>) {
  return row.state === 'watching' || row.state === 'triggered';
}

export const OPEN_CONDITIONAL_SELL_STATES: readonly string[] = ['watching', 'triggered', 'order_pending'];

export function isOpenConditionalSell(row: Pick<ConditionalSellOrderDto, 'state'>) {
  return OPEN_CONDITIONAL_SELL_STATES.includes(row.state);
}

/**
 * Which cancel applies now: the intent itself while nothing was ordered, the
 * ordinary order cancel once its linked limit order is pending, otherwise
 * none (filled, canceled, failed rows are read-only).
 */
export function getConditionalSellCancelPath(
  row: Pick<ConditionalSellOrderDto, 'state' | 'order'>,
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
  position_closed: '보유 수량이 모두 매도되어 이 설정은 끝났어요. 다시 사도 이어지지 않아요.',
  execution_window_expired: '조건 충족 후 30초 안에 주문을 만들지 못했어요.',
  execution_failed: '조건 충족 후 주문을 만들지 못했어요.',
  quantity_unavailable: '발동 시점에 매도할 수 있는 수량이 없었어요. 다른 주문이 예약했거나 이미 매도된 수량이에요.',
};

const FAILURE_CODE_LABEL: Record<string, string> = {
  CONDITIONAL_SELL_QUANTITY_UNAVAILABLE:
    '발동 시점에 매도할 수 있는 수량이 없었어요. 다른 주문이 예약했거나 이미 매도된 수량이에요.',
  INSUFFICIENT_QUANTITY: '발동 시점에 매도할 수 있는 수량이 부족했어요.',
  MARKET_CLOSED: '발동 시점에 정규장이 아니었어요.',
  PRICE_STALE: '발동 시점에 신선한 시세를 확인하지 못했어요.',
  ASSET_PRICE_UNAVAILABLE: '발동 시점에 시세를 확인하지 못했어요.',
  FX_RATE_STALE: '발동 시점에 환율을 확인하지 못했어요.',
  FX_RATE_UNAVAILABLE: '발동 시점에 환율을 확인하지 못했어요.',
  CONDITIONAL_SELL_EXECUTION_WINDOW_EXPIRED: '조건 충족 후 30초 안에 주문을 만들지 못했어요.',
  CONDITIONAL_SELL_CHANGED: '설정 내용이 바뀌어 주문하지 않았어요.',
  PROTECTION_CONFLICT: '기존 TP/SL 보호 조건과 겹쳐 주문하지 않았어요.',
  TRADING_ACCOUNT_NOT_ACTIVE: '계정이 거래할 수 없는 상태였어요.',
  SEASON_NOT_ACTIVE: '시즌이 진행 중이 아니었어요.',
};

/** A user-facing reason for a terminal row; never a raw server code. */
export function getConditionalSellEndReason(
  row: Pick<ConditionalSellOrderDto, 'state' | 'failureCode' | 'terminalReason' | 'order'>,
) {
  if (row.state === 'failed') {
    return (row.failureCode ? FAILURE_CODE_LABEL[row.failureCode] : undefined)
      ?? (row.terminalReason ? TERMINAL_REASON_LABEL[row.terminalReason] : undefined)
      ?? '조건 충족 후 주문을 만들지 못했어요.';
  }
  if (row.state === 'canceled')
    return (row.terminalReason ? TERMINAL_REASON_LABEL[row.terminalReason] : undefined) ?? '감시가 끝났어요.';
  if (row.state === 'order_canceled')
    return row.order?.cancelReason === 'user_canceled' ? '연결된 지정가 매도를 취소했어요.' : '연결된 매도 주문이 체결 없이 종료됐어요.';
  if (row.state === 'order_rejected') return '연결된 매도 주문이 거부됐어요.';
  return null;
}

/**
 * Target vs what can (or did) really happen, in one sentence; null when they
 * are the same. Several settings on one holding may each target all of it;
 * only the unreserved remainder can be sold when one fires.
 */
export function getConditionalSellQuantityNotice(
  row: Pick<ConditionalSellOrderDto, 'state' | 'quantity' | 'position' | 'order' | 'quantityLimited' | 'executionAvailableQuantity'>,
): string | null {
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    a != null && b != null && Number(a) === Number(b);
  if (isLiveConditionalSell(row) && row.position) {
    const { executableQuantity, availableQuantity, reservedQuantity } = row.position;
    // Numbers are never followed by 만/조사 here: "4만" would read as 40,000.
    if (executableQuantity == null)
      return `지금 발동하면 매도할 수 있는 수량이 없어요.${Number(reservedQuantity ?? '0') > 0 ? ' 다른 주문이 보유 수량을 예약하고 있어요.' : ''}`;
    if (!same(executableQuantity, row.quantity))
      return `지금 발동 시 실제 매도 수량 ${fmt(executableQuantity)} (설정 ${fmt(row.quantity)} · 매도 가능 ${fmt(availableQuantity)}${Number(reservedQuantity ?? '0') > 0 ? ` · 다른 주문 예약 ${fmt(reservedQuantity)}` : ''})`;
    return null;
  }
  if (row.order && row.quantityLimited)
    return `설정 수량 ${fmt(row.quantity)} 중 실제 주문 수량 ${fmt(row.order.quantity)} (발동 시 매도 가능 ${fmt(row.executionAvailableQuantity)})`;
  return null;
}

/** Locale-free compact number text for quantities (trailing zeros dropped). */
function fmt(value: string | null | undefined) {
  if (value == null || value === '') return '-';
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export type ConditionalSellResultNotice = {
  title: string;
  detail: string | null;
  next: string;
  tone: 'success' | 'progress' | 'ended' | 'error';
};

const OPEN_NEXT = '아래 대기 목록에서 상태를 확인하고 취소할 수 있어요.';
const ENDED_NEXT = '아래 대기 목록의 종료 이력에서 확인할 수 있어요.';

/**
 * The form's answer to a create, first or replayed with the same key. A
 * replay returns rows as they are NOW, so the copy follows the server's
 * `state`; registration, price reached, order accepted and a real fill stay
 * different sentences.
 */
export function getConditionalSellResultNotice(
  rows: Array<Pick<ConditionalSellOrderDto, 'state' | 'kind' | 'failureCode' | 'terminalReason' | 'order'>>,
): ConditionalSellResultNotice {
  const label = rows.map((row) => getConditionalSellKindLabel(row.kind)).join('·');
  if (rows.every((row) => row.state === 'watching'))
    return { title: `${label} 설정이 등록되었습니다. 감시 중입니다.`, detail: '감시 중에는 보유 수량을 예약하지 않아요.', next: OPEN_NEXT, tone: 'success' };
  if (rows.some((row) => row.state === 'filled'))
    return { title: `${label} 매도가 체결됐어요.`, detail: null, next: ENDED_NEXT, tone: 'success' };
  if (rows.some((row) => row.state === 'order_pending'))
    return { title: '조건이 충족되어 지정가 매도가 접수됐어요. 체결을 기다리고 있어요.', detail: null, next: OPEN_NEXT, tone: 'progress' };
  if (rows.some((row) => row.state === 'triggered'))
    return { title: '조건이 충족되어 매도 주문을 처리하고 있어요.', detail: '아직 체결된 것은 아니에요.', next: OPEN_NEXT, tone: 'progress' };
  const ended = rows.find((row) => row.state === 'failed') ?? rows[0];
  if (ended?.state === 'failed')
    return { title: '조건이 충족됐지만 매도하지 못했어요.', detail: getConditionalSellEndReason(ended), next: ENDED_NEXT, tone: 'error' };
  return { title: '이미 끝난 설정이에요.', detail: ended ? getConditionalSellEndReason(ended) : null, next: ENDED_NEXT, tone: 'ended' };
}

const DECIMAL = (scale: number) => new RegExp(`^\\d{1,16}(?:\\.\\d{1,${scale}})?$`, 'u');

function positiveDecimal(value: string, scale: number) {
  const trimmed = value.trim();
  return DECIMAL(scale).test(trimmed) && Number(trimmed) > 0;
}

export type SellLegDraft = {
  triggerPrice: string;
  executionType: ConditionalSellExecutionType;
  limitPrice: string;
  quantity: string;
};

/**
 * Mirrors the server's input rules for one SELL leg; the server still
 * decides. `holding` is a hint only: a target above today's holding is
 * refused at registration, but several targets may add up to more.
 */
export function getSellLegDraftError(
  draft: SellLegDraft,
  input: { assetType: string | null | undefined; holding: string | null; label?: string },
): string | null {
  const prefix = input.label ? `${input.label} ` : '';
  if (!draft.triggerPrice.trim()) return `${prefix}감시가격을 입력해주세요.`;
  if (!positiveDecimal(draft.triggerPrice, 8)) return `${prefix}감시가격은 0보다 큰 숫자와 소수점 이하 최대 8자리로 입력해주세요.`;
  if (draft.executionType === 'limit') {
    if (!draft.limitPrice.trim()) return `${prefix}발동 시 주문할 지정가격을 입력해주세요.`;
    if (!positiveDecimal(draft.limitPrice, 8)) return `${prefix}지정가격은 0보다 큰 숫자와 소수점 이하 최대 8자리로 입력해주세요.`;
  }
  if (!draft.quantity.trim()) return `${prefix}매도 수량을 입력해주세요.`;
  if (!positiveDecimal(draft.quantity, 6)) return `${prefix}매도 수량은 0보다 큰 숫자와 소수점 이하 최대 6자리로 입력해주세요.`;
  const stock = input.assetType === 'domestic_stock' || input.assetType === 'us_stock';
  if (stock && draft.executionType === 'limit' && !/^\d+$/u.test(draft.quantity.trim()))
    return `${prefix}지정가로 발동하는 주식 매도는 정수 수량만 가능합니다.`;
  if (input.holding !== null && Number(draft.quantity.trim()) > Number(input.holding))
    return `${prefix}수량은 현재 보유 수량(${fmt(input.holding)})을 넘을 수 없어요.`;
  return null;
}

/**
 * True when the last price on screen already meets the condition. Only a
 * hint: registration is judged by the server's own eligible evidence.
 */
export function isSellConditionAlreadyMet(
  condition: ConditionalSellTriggerCondition | null,
  triggerPrice: string,
  currentPrice: string | null | undefined,
) {
  if (!condition || !currentPrice || !positiveDecimal(triggerPrice, 8)) return false;
  const current = Number(currentPrice);
  const trigger = Number(triggerPrice.trim());
  if (!Number.isFinite(current) || current <= 0) return false;
  return condition === 'at_or_above' ? current >= trigger : current <= trigger;
}
