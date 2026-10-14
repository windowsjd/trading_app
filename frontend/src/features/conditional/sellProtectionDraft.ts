import Decimal from 'decimal.js';

/**
 * 손절가/익절가 설정 (independent stop-loss/take-profit, 2026-10-15) as pure
 * rules, kept free of React and the API client so they run under `node --test`.
 *
 * Each setting is a trigger price plus a share of today's holding that is
 * fixed into a quantity when it is registered. When the price is reached the
 * server sells at market at most what is then unreserved. Per holding the
 * live take-profits add up to at most the holding, and the stop-losses
 * separately too; the server re-checks both rules and the duplicate price.
 * These rules only explain the form — they never decide a registration.
 */
export type ProtectionKind = 'take_profit' | 'stop_loss';

/** 익절 first, then 손절 (the form's order). */
export const PROTECTION_KINDS: readonly ProtectionKind[] = ['take_profit', 'stop_loss'];

export const PROTECTION_KIND_LABEL: Record<ProtectionKind, string> = {
  take_profit: '익절',
  stop_loss: '손절',
};

/** The order quantity unit (server orderInputQuantityScale). */
export const PROTECTION_QUANTITY_SCALE = 6;
const MIN_UNIT = '0.000001';

export type ProtectionLegDraft = {
  enabled: boolean;
  triggerPrice: string;
  /** Whole percent of today's holding, 0–100. */
  percent: number;
};

export const EMPTY_PROTECTION_LEG: ProtectionLegDraft = { enabled: false, triggerPrice: '', percent: 0 };

/** A server row as the form needs it (live list of this account). */
export type LiveProtectionRow = {
  assetId: string;
  kind: string;
  state: string;
  triggerPrice: string;
  quantity: string;
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

/** Locale-free quantity text: trailing zeros dropped, never rounded up. */
export function formatProtectionQuantity(value: Decimal | string | null | undefined) {
  if (value === null || value === undefined) return '-';
  const parsed = typeof value === 'string' ? decimal(value) : value;
  return parsed ? parsed.toDecimalPlaces(PROTECTION_QUANTITY_SCALE, Decimal.ROUND_DOWN).toFixed() : '-';
}

/**
 * The order quantity for a share of the holding: cut down to 6 decimals,
 * never above the holding. Null when the holding is unknown or the share is
 * zero or smaller than one unit.
 */
export function quantityAtPercent(holding: string | null, percent: number): string | null {
  const held = decimal(holding);
  if (!held || held.lte(0) || !Number.isInteger(percent) || percent <= 0 || percent > 100) return null;
  const quantity = percent === 100
    ? held.toDecimalPlaces(PROTECTION_QUANTITY_SCALE, Decimal.ROUND_DOWN)
    : held.mul(percent).div(100).toDecimalPlaces(PROTECTION_QUANTITY_SCALE, Decimal.ROUND_DOWN);
  return quantity.gt(0) ? quantity.toFixed() : null;
}

/** Live (still watching) settings of one kind on this asset. */
export function liveProtectionRows(rows: readonly LiveProtectionRow[] | null | undefined, assetId: string, kind: ProtectionKind) {
  return (rows ?? []).filter((row) => row.assetId === assetId && row.kind === kind
    && (row.state === 'watching' || row.state === 'triggered'));
}

export function liveProtectionTotal(rows: readonly LiveProtectionRow[] | null | undefined, assetId: string, kind: ProtectionKind) {
  return liveProtectionRows(rows, assetId, kind).reduce((sum, row) => sum.add(decimal(row.quantity) ?? 0), new Decimal(0));
}

/** What a new setting of this kind may still target (never negative). */
export function protectionRoom(holding: string | null, rows: readonly LiveProtectionRow[] | null | undefined, assetId: string, kind: ProtectionKind) {
  const held = decimal(holding);
  if (!held) return null;
  return Decimal.max(held.sub(liveProtectionTotal(rows, assetId, kind)), 0);
}

function positivePrice(value: string) {
  return /^\d{1,16}(?:\.\d{1,8})?$/u.test(value.trim()) && Number(value.trim()) > 0;
}

/**
 * The first problem of one enabled setting, in the order the user fixes it;
 * null when the form may send it. A known holding is required (the share is
 * of today's holding).
 */
export function getProtectionLegError(input: {
  kind: ProtectionKind;
  draft: ProtectionLegDraft;
  holding: string | null;
  assetId: string;
  liveRows: readonly LiveProtectionRow[] | null | undefined;
}): string | null {
  const { kind, draft } = input;
  const name = PROTECTION_KIND_LABEL[kind];
  if (!draft.triggerPrice.trim()) return `${name}가를 입력해주세요.`;
  if (!positivePrice(draft.triggerPrice)) return `${name}가는 0보다 큰 숫자와 소수점 이하 최대 8자리로 입력해주세요.`;
  if (draft.percent <= 0) return `${name} 수량 비율을 선택해주세요.`;
  const quantity = quantityAtPercent(input.holding, draft.percent);
  if (!quantity) {
    return decimal(input.holding)?.gt(0)
      ? `선택한 비율의 수량이 최소 주문 단위(${MIN_UNIT})보다 적어요. 비율을 높여주세요.`
      : '보유 수량을 확인한 뒤 설정할 수 있어요.';
  }
  const price = new Decimal(draft.triggerPrice.trim());
  const live = liveProtectionRows(input.liveRows, input.assetId, kind);
  if (live.some((row) => decimal(row.triggerPrice)?.eq(price)))
    return `같은 ${name}가로 감시 중인 설정이 이미 있어요. 다른 가격을 입력해주세요.`;
  const room = protectionRoom(input.holding, input.liveRows, input.assetId, kind);
  if (room && new Decimal(quantity).gt(room)) {
    // Numbers stand in parentheses: no particle ever follows one.
    return room.gt(0)
      ? `감시 중인 ${name} 설정과 합치면 보유 수량을 넘어요. (감시 중 ${formatProtectionQuantity(liveProtectionTotal(input.liveRows, input.assetId, kind))} · 추가 가능 ${formatProtectionQuantity(room)})`
      : `감시 중인 ${name} 설정이 이미 보유 수량 전체를 대상으로 해요. 기존 ${name} 설정을 취소한 뒤 추가할 수 있어요.`;
  }
  return null;
}

/** Hint only: the screen's last price already meets the setting. */
export function isProtectionAlreadyMet(kind: ProtectionKind, triggerPrice: string, currentPrice: string | null | undefined) {
  if (!currentPrice || !positivePrice(triggerPrice)) return false;
  const current = decimal(currentPrice);
  if (!current || current.lte(0)) return false;
  const trigger = new Decimal(triggerPrice.trim());
  return kind === 'take_profit' ? current.gte(trigger) : current.lte(trigger);
}
