import Decimal from 'decimal.js';

/**
 * 손절가/익절가 설정 — the one bottom sheet for every target (2026-10-16): a Spot
 * holding, a Futures position, a pending entry (BUY Limit, conditional BUY,
 * Futures limit or conditional entry) and the draft of an entry being created.
 * Pure rules (no React, no API client) so they run under `node --test`.
 *
 * Every setting is independent: a take-profit and a stop-loss never cancel
 * each other, each kind may be split over several prices, and per target the
 * live (or pending) settings of ONE kind cover at most 100% — stop-losses and
 * take-profits are bounded separately. On a holding or position the share
 * becomes a fixed quantity when registered; on an entry it stays a share of
 * whatever the entry actually fills. The server re-checks everything; these
 * rules only explain the form.
 */
export type TpSlKind = 'take_profit' | 'stop_loss';
export type TpSlDirection = 'long' | 'short';

export const TP_SL_TITLE = '손절가/익절가 설정';
/** 익절 first, then 손절 (the form's order). */
export const TP_SL_KINDS: readonly TpSlKind[] = ['take_profit', 'stop_loss'];
export const TP_SL_KIND_LABEL: Record<TpSlKind, string> = { take_profit: '익절', stop_loss: '손절' };
export const TP_SL_RATIOS = [25, 50, 75, 100] as const;

export type TpSlLegDraft = {
  enabled: boolean;
  triggerPrice: string;
  /** Whole percent, 0–100. */
  percent: number;
};
export const EMPTY_TP_SL_LEG: TpSlLegDraft = { enabled: false, triggerPrice: '', percent: 0 };

/** A registered or pending setting as the sheet compares against it. */
export type TpSlExisting = {
  kind: string;
  triggerPrice: string;
  /** Holding/position settings: the target quantity. */
  quantity?: string | null;
  /** Entry plans: the share of the fill. */
  ratioPercent?: number | null;
};

function decimal(value: string | null | undefined): Decimal | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  try {
    const parsed = new Decimal(value.trim());
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

export function isTpSlPrice(value: string) {
  return /^\d{1,16}(?:\.\d{1,8})?$/u.test(value.trim()) && Number(value.trim()) > 0;
}

/**
 * Whether a kind fires when the price rises to its trigger: a long (and every
 * Spot holding) take-profit and a short stop-loss; the other two fire on a fall.
 */
export function tpSlWatchesRise(direction: TpSlDirection, kind: TpSlKind) {
  return (direction === 'long') === (kind === 'take_profit');
}

/** `익절 2건 · 손절 1건` for the given live rows; null when there are none. */
export function tpSlCountSummary(rows: readonly { kind: string }[] | null | undefined): string | null {
  const count = (kind: TpSlKind) => (rows ?? []).filter((row) => row.kind === kind).length;
  const parts = TP_SL_KINDS.map((kind) => [kind, count(kind)] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${TP_SL_KIND_LABEL[kind]} ${n}건`);
  return parts.length ? parts.join(' · ') : null;
}

/** Locale-free quantity text: trailing zeros dropped, never rounded up. */
export function formatTpSlQuantity(value: Decimal | string | null | undefined, scale = 8) {
  if (value === null || value === undefined) return '-';
  const parsed = typeof value === 'string' ? decimal(value) : value;
  return parsed ? parsed.toDecimalPlaces(scale, Decimal.ROUND_DOWN).toFixed() : '-';
}

/**
 * The quantity for a whole-percent share of a basis, cut down to `scale`
 * decimals and never above the basis. Null when the basis is unknown or the
 * share is zero or below one unit.
 */
export function quantityForPercent(basis: string | null | undefined, percent: number, scale: number): string | null {
  const base = decimal(basis);
  if (!base || base.lte(0) || !Number.isInteger(percent) || percent <= 0 || percent > 100) return null;
  const quantity = (percent === 100 ? base : base.mul(percent).div(100)).toDecimalPlaces(scale, Decimal.ROUND_DOWN);
  return quantity.gt(0) ? quantity.toFixed() : null;
}

function sameKind(rows: readonly TpSlExisting[] | null | undefined, kind: TpSlKind) {
  return (rows ?? []).filter((row) => row.kind === kind);
}

/** Σ live target quantities of one kind. */
export function tpSlQuantityTotal(rows: readonly TpSlExisting[] | null | undefined, kind: TpSlKind) {
  return sameKind(rows, kind).reduce((sum, row) => sum.add(decimal(row.quantity ?? null) ?? 0), new Decimal(0));
}

/** What a new setting of this kind may still target (never negative). */
export function tpSlQuantityRoom(basis: string | null | undefined, rows: readonly TpSlExisting[] | null | undefined, kind: TpSlKind) {
  const base = decimal(basis);
  return base ? Decimal.max(base.sub(tpSlQuantityTotal(rows, kind)), 0) : null;
}

/** Percent still free for a new plan of this kind on one entry. */
export function tpSlPercentRoom(rows: readonly TpSlExisting[] | null | undefined, kind: TpSlKind) {
  return Math.max(0, 100 - sameKind(rows, kind).reduce((sum, row) => sum + (row.ratioPercent ?? 0), 0));
}

export type TpSlLegContext = {
  kind: TpSlKind;
  draft: TpSlLegDraft;
  direction: TpSlDirection;
  /**
   * `quantity`: a holding/position (the share becomes a fixed quantity of
   * `basis`); `ratio`: an entry (the share stays a percent of its fill).
   */
  mode: 'quantity' | 'ratio';
  basis: string | null;
  scale: number;
  /** Registered settings (quantity) or pending plans (ratio) of this target. */
  existing: readonly TpSlExisting[] | null | undefined;
  /**
   * Entries only: the entry's own price. A pending entry has no fill yet, so
   * a stop-loss/take-profit must sit on its protective side of this price.
   */
  entryPrice?: string | null;
};

/**
 * The first problem of one enabled leg, in the order the user fixes it; null
 * when the form may send it.
 */
export function getTpSlLegError(input: TpSlLegContext): string | null {
  const { kind, draft } = input;
  const name = TP_SL_KIND_LABEL[kind];
  if (!draft.triggerPrice.trim()) return `${name}가를 입력해주세요.`;
  if (!isTpSlPrice(draft.triggerPrice)) return `${name}가는 0보다 큰 숫자와 소수점 이하 최대 8자리로 입력해주세요.`;
  if (draft.percent <= 0) return `${name} 비율을 선택해주세요.`;
  const price = new Decimal(draft.triggerPrice.trim());
  const rise = tpSlWatchesRise(input.direction, kind);
  const entry = decimal(input.entryPrice ?? null);
  if (input.mode === 'ratio' && entry && (rise ? price.lte(entry) : price.gte(entry)))
    return `${name}가는 진입 가격보다 ${rise ? '높게' : '낮게'} 입력해주세요.`;
  if (sameKind(input.existing, kind).some((row) => decimal(row.triggerPrice)?.eq(price)))
    return `같은 ${name}가로 등록된 설정이 이미 있어요. 다른 가격을 입력해주세요.`;
  if (input.mode === 'ratio') {
    const room = tpSlPercentRoom(input.existing, kind);
    if (draft.percent > room)
      return room > 0
        ? `${name} 비율의 합은 100%를 넘을 수 없어요. (추가 가능 ${room}%)`
        : `${name} 설정이 이미 100%를 대상으로 해요. 기존 ${name} 설정을 취소한 뒤 추가할 수 있어요.`;
    return null;
  }
  const quantity = quantityForPercent(input.basis, draft.percent, input.scale);
  if (!quantity)
    return decimal(input.basis)?.gt(0)
      ? '선택한 비율의 수량이 최소 단위보다 적어요. 비율을 높여주세요.'
      : '보유 수량을 확인한 뒤 설정할 수 있어요.';
  const room = tpSlQuantityRoom(input.basis, input.existing, kind);
  if (room && new Decimal(quantity).gt(room))
    // Numbers stand in parentheses: no particle ever follows one.
    return room.gt(0)
      ? `등록된 ${name} 설정과 합치면 보유 수량을 넘어요. (등록 ${formatTpSlQuantity(tpSlQuantityTotal(input.existing, kind), input.scale)} · 추가 가능 ${formatTpSlQuantity(room, input.scale)})`
      : `${name} 설정이 이미 보유 수량 전체를 대상으로 해요. 기존 ${name} 설정을 취소한 뒤 추가할 수 있어요.`;
  return null;
}

/** Hint only (holdings/positions): the screen's last price already meets the leg. */
export function isTpSlAlreadyMet(direction: TpSlDirection, kind: TpSlKind, triggerPrice: string, currentPrice: string | null | undefined) {
  if (!currentPrice || !isTpSlPrice(triggerPrice)) return false;
  const current = decimal(currentPrice);
  if (!current || current.lte(0)) return false;
  const trigger = new Decimal(triggerPrice.trim());
  return tpSlWatchesRise(direction, kind) ? current.gte(trigger) : current.lte(trigger);
}

/**
 * `매도 가능 금액` of a Spot holding in USD: the server's sellable quantity at
 * the current valuation price, a KRW price converted with a usable USD/KRW
 * rate. An estimate of value, never proceeds after fees; null when the price
 * or the needed rate is unknown (never a made-up 0).
 */
export function sellableUsdEstimate(input: {
  available: string | null | undefined;
  price: string | null | undefined;
  priceCurrency: string | null | undefined;
  usdKrw: string | null | undefined;
}): string | null {
  const available = decimal(input.available);
  const price = decimal(input.price);
  if (!available || available.lt(0) || !price || price.lte(0)) return null;
  const local = available.mul(price);
  if (input.priceCurrency === 'USD') return local.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2);
  if (input.priceCurrency !== 'KRW') return null;
  const rate = decimal(input.usdKrw);
  if (!rate || rate.lte(0)) return null;
  return local.div(rate).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2);
}

const PLAN_FAILURE_TEXT: Record<string, string> = {
  ENTRY_TP_SL_TOTAL_EXCEEDS_HOLDING: '같은 종류 설정의 합이 보유 수량을 넘어 활성화하지 못했어요.',
  ENTRY_TP_SL_DUPLICATE_PRICE: '같은 가격의 설정이 이미 있어 활성화하지 못했어요.',
  PROTECTION_CONFLICT: '기존 TP/SL(OCO) 보호와 함께 쓸 수 없어 활성화하지 못했어요.',
  ENTRY_TP_SL_QUANTITY_TOO_SMALL: '체결 수량의 비율이 최소 단위보다 작아 활성화하지 못했어요.',
  CONDITIONAL_SELL_LIMIT_EXCEEDED: '감시 중인 설정이 너무 많아 활성화하지 못했어요.',
  FUTURES_TP_SL_LIMIT_EXCEEDED: '감시 중인 설정이 너무 많아 활성화하지 못했어요.',
  ENTRY_TP_SL_POSITION_UNAVAILABLE: '체결 후 보유 수량을 확인하지 못해 활성화하지 못했어요.',
};

/** A plan's state as the sheet and lists say it (never "filled": a plan only activates). */
export function getEntryPlanStateLabel(plan: { status: string; terminalReason: string | null }) {
  if (plan.status === 'pending') return '체결 후 활성화';
  if (plan.status === 'activated') return '활성화됨';
  if (plan.status === 'failed') return '활성화 실패';
  return plan.terminalReason === 'entry_canceled'
    ? '진입 주문 종료로 취소'
    : plan.terminalReason === 'entry_failed'
      ? '진입 실패로 종료'
      : '취소됨';
}

export function getEntryPlanFailureText(plan: { status: string; failureCode: string | null }) {
  if (plan.status !== 'failed') return null;
  return PLAN_FAILURE_TEXT[plan.failureCode ?? ''] ?? '보유 설정의 제한 때문에 활성화하지 못했어요. 보유종목에서 다시 설정해 주세요.';
}

const FUTURES_END_TEXT: Record<string, string> = {
  user_canceled: '취소됨',
  position_closed: '포지션 종료로 끝남',
  liquidated: '강제청산으로 끝남',
  season_settled: '시즌 정산으로 끝남',
  season_ended: '시즌 종료로 끝남',
  participant_excluded: '시즌 참가 제외로 끝남',
  account_not_tradable: '계정 거래 중지로 끝남',
  execution_window_expired: '실행 시간 초과',
  execution_failed: '실행 실패',
};

/** A Futures setting's state: `filled` only when its reduction executed. */
export function getFuturesTpSlStateLabel(setting: { state: string; terminalReason: string | null }) {
  if (setting.state === 'watching') return '감시 중';
  if (setting.state === 'triggered') return '조건 충족 · 실행 중';
  if (setting.state === 'filled') return '실행됨';
  if (setting.state === 'failed') return FUTURES_END_TEXT[setting.terminalReason ?? ''] ?? '실행 실패';
  return FUTURES_END_TEXT[setting.terminalReason ?? ''] ?? '종료됨';
}
