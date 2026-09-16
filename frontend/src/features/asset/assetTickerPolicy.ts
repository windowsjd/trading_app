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
  realtime?: boolean;
  delayed?: boolean;
  /** Backend calendar assessment, independent of the snapshot's age. */
  marketStatus?: 'open' | 'closed' | 'unknown';
  marketEvaluatedAt?: string;
  tradable?: boolean;
  tradeBlockedReason?: string | null;
  /** Provider-declared unit-price decimals (Binance PRICE_FILTER.tickSize). */
  displayPriceDecimals?: number | null;
  priceLocal: string | null;
  priceCurrency?: 'KRW' | 'USD';
  priceKrw: string | null;
  priceKrwState?: string;
  /** Present when the server could not convert THIS price to KRW. */
  priceKrwReason?: string | null;
  priceKrwMessage?: string | null;
  /** Source of the FX row used for this ticker's KRW conversion. */
  fxRateSource?: { sourceType?: string; sourceName?: string } | null;
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
export function getTickerTimestamp(payload: AssetTickerMessage): number | null {
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
  if (isClosedMarketSnapshot(payload)) return false;
  const freshnessAgeSeconds = payload?.freshnessAgeSeconds;
  if (typeof freshnessAgeSeconds !== 'number') return false;

  // Server-driven freshness metadata is not yet exposed as a threshold.
  return freshnessAgeSeconds > STALE_FRESHNESS_THRESHOLD_SECONDS;
}

/** How often screens re-judge staleness when NO new ticker arrives. */
export const STALE_RECHECK_INTERVAL_MS = 5_000;

/**
 * Age of a ticker at `nowMs`, measured from its own event time
 * (capturedAt → effectiveAt). Null when the ticker carries no usable
 * timestamp, in which case callers fall back to `freshnessAgeSeconds`.
 */
export function getTickerAgeMs(
  payload: AssetTickerMessage | null | undefined,
  nowMs: number,
): number | null {
  if (!payload) return null;
  const timestamp = getTickerTimestamp(payload);
  if (timestamp === null) return null;
  return Math.max(0, nowMs - timestamp);
}

/**
 * Time-aware staleness against the SAME threshold as `isTickerStale`, so a
 * screen flips to stale by the clock advancing — not only when the next
 * (possibly never-arriving) ticker reports a large freshness age.
 */
export function isTickerStaleAt(
  payload: AssetTickerMessage | null | undefined,
  nowMs: number,
): boolean {
  if (!payload) return false;
  if (isClosedMarketSnapshot(payload)) return false;
  const ageMs = getTickerAgeMs(payload, nowMs);
  if (ageMs === null) return isTickerStale(payload);
  return ageMs > STALE_FRESHNESS_THRESHOLD_SECONDS * 1000;
}

/**
 * Whether `next` may replace `current`:
 *  - the same snapshot id is skipped unless its derived daily return changed,
 *  - an older event time never overwrites a newer one,
 *  - a priced event with NO timestamp never overwrites an existing ticker
 *    (it cannot be ordered), while an unavailable event still gets through so
 *    the screen learns the price went away.
 */
export function shouldAcceptTicker(
  current: AssetTickerAcceptState | null | undefined,
  next: AssetTickerMessage,
): boolean {
  const nextAssessment = parseTickerTimestamp(next.marketEvaluatedAt);
  const currentAssessment = parseTickerTimestamp(
    current?.ticker.marketEvaluatedAt,
  );
  if (
    nextAssessment !== null &&
    currentAssessment !== null &&
    nextAssessment < currentAssessment
  )
    return false;
  // A server session transition replaces even a newer cached live price.
  if (
    nextAssessment !== null &&
    next.marketStatus !== current?.ticker.marketStatus
  )
    return true;
  if (isClosedMarketSnapshot(current?.ticker) && !next.marketStatus)
    return false;
  if (isClosedMarketSnapshot(next)) {
    return (
      next.assetPriceSnapshotId !== current?.snapshotId ||
      next.priceLocal !== current?.ticker.priceLocal ||
      next.changeRate !== current?.ticker.changeRate
    );
  }
  const snapshotId = next.assetPriceSnapshotId ?? null;
  if (
    snapshotId && current && snapshotId === current.snapshotId &&
    next.changeRate === current.ticker.changeRate
  ) return false;

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

export function isClosedMarketSnapshot(
  ticker?: AssetTickerMessage | null,
): boolean {
  return (
    !!ticker &&
    ticker.realtime === false &&
    (ticker.marketStatus === 'closed' || ticker.marketStatus === 'unknown') &&
    parseTickerTimestamp(ticker.marketEvaluatedAt) !== null
  );
}

/** Use backend market state only; no client session clock or holiday rules. */
export function canOverlayAssetTicker(
  asset: { assetType?: string; marketStatus?: string },
  ticker?: AssetTickerMessage | null,
): boolean {
  if (!ticker) return false;
  if (asset.assetType === 'crypto') return true;
  if (isClosedMarketSnapshot(ticker)) return true;
  if (
    ticker.marketStatus === 'open' &&
    parseTickerTimestamp(ticker.marketEvaluatedAt) !== null
  )
    return true;
  return asset.marketStatus !== 'closed' && asset.marketStatus !== 'unknown';
}

export function applyTickerMarketState<
  T extends { assetType?: string; marketStatus?: string; isActive?: boolean },
>(asset: T, ticker?: AssetTickerMessage | null): T {
  if (
    asset.assetType === 'crypto' ||
    !ticker?.marketStatus ||
    parseTickerTimestamp(ticker.marketEvaluatedAt) === null
  )
    return asset;
  if (ticker.marketStatus === 'open')
    return {
      ...asset,
      marketStatus: 'open',
      ...(typeof ticker.tradable === 'boolean'
        ? {
            tradable: ticker.tradable,
            tradeBlockedReason: ticker.tradeBlockedReason ?? null,
          }
        : {}),
    };
  if (!isClosedMarketSnapshot(ticker)) return asset;
  return {
    ...asset,
    marketStatus: ticker.marketStatus,
    tradable: false,
    tradeBlockedReason:
      asset.isActive === false
        ? 'ASSET_INACTIVE'
        : ticker.marketStatus === 'closed'
          ? 'MARKET_CLOSED'
          : 'UNKNOWN',
  };
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
