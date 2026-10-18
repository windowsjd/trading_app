// A closed US market with no stored price shows the latest completed session's
// confirmed end-of-day close (server: assets.service
// LAST_SESSION_CLOSE_FALLBACK_REASON). It is display only — never a live
// price and never what an order executes at — so the screens name it "종가"
// instead of "현재가". The session date is not shown (2026-10-18); the price's
// own priceEffectiveAt is unchanged. Pure module: unit-tested under `node --test`.

export const LAST_SESSION_CLOSE_FALLBACK_REASON = 'market_closed_last_close';

type PriceLike = { priceSource?: unknown } | null | undefined;

export function isLastSessionClosePrice(priceSource: unknown): boolean {
  return (
    priceSource !== null &&
    typeof priceSource === 'object' &&
    (priceSource as { fallbackReason?: unknown }).fallbackReason ===
      LAST_SESSION_CLOSE_FALLBACK_REASON
  );
}

/** `종가` for a last-close price (never the session date), else null. */
export function getLastSessionCloseLabel(price: PriceLike): string | null {
  return price && isLastSessionClosePrice(price.priceSource) ? '종가' : null;
}

/** One line for the detail screen: a confirmed close, not a live price. */
export function getLastSessionCloseNotice(price: PriceLike): string | null {
  const label = getLastSessionCloseLabel(price);
  return label ? `미국 정규장 마감 · ${label} (실시간 시세 아님)` : null;
}
