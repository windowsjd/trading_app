// A closed US market with no stored price shows the latest completed session's
// confirmed end-of-day close (server: assets.service
// LAST_SESSION_CLOSE_FALLBACK_REASON). It is display only — never a live
// price and never what an order executes at — so the screens name it as that
// New York trading date's close instead of "현재가". Pure module: unit-tested
// under `node --test`.

export const LAST_SESSION_CLOSE_FALLBACK_REASON = 'market_closed_last_close';

const NEW_YORK_MONTH_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  calendar: 'gregory',
  numberingSystem: 'latn',
  month: '2-digit',
  day: '2-digit',
});

type PriceLike = {
  priceSource?: unknown;
  priceEffectiveAt?: string | null;
} | null | undefined;

export function isLastSessionClosePrice(priceSource: unknown): boolean {
  return (
    priceSource !== null &&
    typeof priceSource === 'object' &&
    (priceSource as { fallbackReason?: unknown }).fallbackReason ===
      LAST_SESSION_CLOSE_FALLBACK_REASON
  );
}

/** `10/16 종가` (New York trading date) for a last-close price, else null. */
export function getLastSessionCloseLabel(price: PriceLike): string | null {
  if (!price || !isLastSessionClosePrice(price.priceSource)) return null;
  // priceEffectiveAt is that session's regular close, on its New York date.
  const at = new Date(price.priceEffectiveAt ?? '');
  if (!Number.isFinite(at.getTime())) return null;
  const parts = NEW_YORK_MONTH_DAY.formatToParts(at);
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return month && day ? `${Number(month)}/${Number(day)} 종가` : null;
}

/** One line for the detail screen: the close's date and that it is not live. */
export function getLastSessionCloseNotice(price: PriceLike): string | null {
  const label = getLastSessionCloseLabel(price);
  return label ? `미국 정규장 마감 · ${label} (실시간 시세 아님)` : null;
}
