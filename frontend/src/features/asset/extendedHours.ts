// US pre-market / after-hours (2026-11-10). With the server's extended-hours
// prices on, a US stock carries `extendedHoursSession` ('pre_market' |
// 'after_hours' | null) beside `marketStatus`, which stays 'closed' outside
// the regular session (no market orders). A price observed in those hours
// carries its own source name. Its value is Tiingo's consolidated reference
// price (`tngoLast`), not any one exchange's last trade, so the screens name
// the session and the price's time instead of calling it a live price. The
// session comes from the server only: no client clock or holiday rules here.
// Pure module: unit-tested under `node --test`.
import { formatKstDateTime } from '../../utils/format.ts';

export const EXTENDED_HOURS_PRICE_SOURCE = 'tiingo_us_extended_reference_price';

export type ExtendedHoursSession = 'pre_market' | 'after_hours';

export function readExtendedHoursSession(value: unknown): ExtendedHoursSession | null {
  return value === 'pre_market' || value === 'after_hours' ? value : null;
}

export function getExtendedHoursSessionLabel(value: unknown): '프리마켓' | '애프터마켓' | null {
  const session = readExtendedHoursSession(value);
  return session === 'pre_market' ? '프리마켓' : session === 'after_hours' ? '애프터마켓' : null;
}

export function isExtendedHoursPrice(priceSource: unknown): boolean {
  return (
    priceSource !== null &&
    typeof priceSource === 'object' &&
    (priceSource as { sourceName?: unknown }).sourceName === EXTENDED_HOURS_PRICE_SOURCE
  );
}

type PriceLike = { priceSource?: unknown; priceEffectiveAt?: string | null } | null | undefined;

/** The label beside a shown extended-hours price (its session), else null. */
export function getExtendedHoursPriceLabel(price: PriceLike, session: unknown): string | null {
  if (!price || !isExtendedHoursPrice(price.priceSource)) return null;
  return getExtendedHoursSessionLabel(session) ?? '시간외';
}

/**
 * One line for the detail screen while the server reports an extended-hours
 * session: what the shown price is, and when it was observed (KST).
 */
export function getExtendedHoursNotice(price: PriceLike, session: unknown): string | null {
  const label = getExtendedHoursSessionLabel(session);
  if (!label) return null;
  if (!price || !isExtendedHoursPrice(price.priceSource))
    return `미국 ${label} · ${label} 시세가 아직 없어 정규장 마지막 시세를 보여줘요`;
  const at = formatKstDateTime(price.priceEffectiveAt ?? null);
  const time = at === '-' ? '' : ` · ${at.slice(11)} 기준(한국시간)`;
  return `미국 ${label} 시세${time} · Tiingo 통합 참조가로, 실제 거래소 체결가와 다를 수 있어요`;
}

/**
 * Whether a submitted US limit order can fill in the current session: the
 * server reports an extended-hours session and lists the asset's market in
 * order capabilities (`limitOrder.extendedHoursMarkets`).
 */
export function canFillLimitInExtendedHours(input: {
  assetType?: string | null;
  extendedHoursSession?: unknown;
  extendedHoursMarkets?: readonly string[] | null;
}): boolean {
  return (
    input.assetType === 'us_stock' &&
    readExtendedHoursSession(input.extendedHoursSession) !== null &&
    (input.extendedHoursMarkets ?? []).includes('US')
  );
}
