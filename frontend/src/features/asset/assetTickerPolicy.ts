/**
 * The ONE asset_ticker acceptance policy, shared by the detail screen
 * (useAssetTicker, single asset) and the market list (useMarketTickers, many
 * assets). Both screens must agree on what counts as a newer, acceptable, or
 * stale ticker, so the rules live here as pure functions instead of being
 * re-implemented per screen.
 */

export interface AssetTickerMessage {
  type: 'asset_ticker';
  assetId: string;
  symbol?: string;
  name?: string;
  /** Provider-declared unit-price decimals (Binance PRICE_FILTER.tickSize). */
  displayPriceDecimals?: number | null;
  priceLocal: string | null;
  priceCurrency?: 'KRW' | 'USD';
  priceKrw: string | null;
  priceKrwState?: string;
  changeRate?: string | null;
  assetPriceSnapshotId?: string | null;
  priceCapturedAt?: string | null;
  priceEffectiveAt?: string | null;
  capturedAt?: string | null;
  freshnessAgeSeconds?: number | null;
  priceSource?: { sourceType?: string; sourceName?: string } | null;
  reason?: string;
  message?: string;
}

/** Per-asset bookkeeping needed to judge the NEXT ticker. */
export type AssetTickerAcceptState = {
  ticker: AssetTickerMessage;
  snapshotId: string | null;
  timestamp: number | null;
};

export const STALE_FRESHNESS_THRESHOLD_SECONDS = 60;

export function parseTickerTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Event time of a ticker: captured-at first, effective-at as a fallback. */
export function getTickerTimestamp(
  payload: AssetTickerMessage,
): number | null {
  return (
    parseTickerTimestamp(payload.priceCapturedAt ?? payload.capturedAt) ??
    parseTickerTimestamp(payload.priceEffectiveAt)
  );
}

/** A price-less event (server could not price the asset right now). */
export function isUnavailableTicker(payload: AssetTickerMessage): boolean {
  return !!payload.priceKrwState && payload.priceKrwState !== 'available';
}

export function isTickerStale(
  payload: AssetTickerMessage | null | undefined,
): boolean {
  const freshnessAgeSeconds = payload?.freshnessAgeSeconds;
  if (typeof freshnessAgeSeconds !== 'number') return false;

  // Server-driven freshness metadata is not yet exposed as a threshold.
  return freshnessAgeSeconds > STALE_FRESHNESS_THRESHOLD_SECONDS;
}

/**
 * Whether `next` may replace `current`:
 *  - the same snapshot id is never applied twice,
 *  - an older event time never overwrites a newer one,
 *  - a priced event with NO timestamp never overwrites an existing ticker
 *    (it cannot be ordered), while an unavailable event still gets through so
 *    the screen learns the price went away.
 */
export function shouldAcceptTicker(
  current: AssetTickerAcceptState | null | undefined,
  next: AssetTickerMessage,
): boolean {
  const snapshotId = next.assetPriceSnapshotId ?? null;
  if (snapshotId && current && snapshotId === current.snapshotId) return false;

  const nextTimestamp = getTickerTimestamp(next);
  if (nextTimestamp === null) {
    return !current || isUnavailableTicker(next);
  }

  const currentTimestamp = current?.timestamp ?? null;
  if (currentTimestamp !== null && nextTimestamp < currentTimestamp) {
    return false;
  }

  return true;
}

export function toAssetTickerAcceptState(
  payload: AssetTickerMessage,
): AssetTickerAcceptState {
  return {
    ticker: payload,
    snapshotId: payload.assetPriceSnapshotId ?? null,
    timestamp: getTickerTimestamp(payload),
  };
}

/**
 * Applies the policy: returns the state to keep. Identity-equal to `current`
 * when the ticker was rejected, so callers can skip a re-render.
 */
export function applyTicker(
  current: AssetTickerAcceptState | null,
  next: AssetTickerMessage,
): AssetTickerAcceptState | null {
  if (!shouldAcceptTicker(current, next)) return current;
  return toAssetTickerAcceptState(next);
}
