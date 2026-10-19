/**
 * Chart windows of the USDⓈ-M contract chart (2026-10-20) — PURE.
 *
 * Every timeframe shows the contract's own `/fapi/v1/klines` series (contract
 * trade price; never Mark, Index or Spot klines). Two delivery paths exist:
 *
 *   4h          stored completed history (`futures_market_candles`, 96 days),
 *               collected by `futures_candle_sync`; reads are DB-only.
 *   5m … 1h, 1d the contract's NATIVE Binance klines of that interval, taken on
 *               demand by the server (FuturesCandleProviderService) and shared
 *               by every viewer through one in-process cache per contract and
 *               interval. Nothing is stored, so there is no retention and no
 *               backfill: Binance is the history, and only the window below
 *               is ever requested.
 *
 * Native klines rather than a stored 5m feed aggregated into 15m/30m/1h: the
 * 30m/1h windows are 14 days, which would need ≥ 14 days of stored 5m per
 * contract (≈ 400k rows for 100 contracts) plus a 100-call-per-minute upkeep
 * for every listed contract whether anyone looks or not. Binance aggregates
 * its own klines on the same UTC grid, so the native series is exactly the
 * aggregate a stored 5m feed would give — at one request per viewed window.
 *
 * Windows follow the general crypto chart (frontend `chartTimeframes.ts`):
 * 5m ≈ 2 days, 15m 3 days, 30m/1h 14 days, 1d 1 year. The 5m window is a
 * rolling 48 h here (contracts trade 24/7; the Spot tab anchors on 09:00 KST).
 */

export const FUTURES_CHART_INTERVALS = [
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
] as const;

export type FuturesChartInterval = (typeof FUTURES_CHART_INTERVALS)[number];

export type FuturesChartRange = '2d' | '3d' | '14d' | '96d' | '1y';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type FuturesChartWindow = {
  interval: FuturesChartInterval;
  range: FuturesChartRange;
  intervalMs: number;
  rangeMs: number;
  /** Largest `limit` a request may ask for; also the default. */
  maxLimit: number;
  /** stored = futures_market_candles; provider = on-demand native klines. */
  delivery: 'stored' | 'provider';
  /**
   * How long a provider read stays current for every viewer. A bucket
   * boundary always ends it earlier (see isProviderReadCurrent).
   */
  freshMs: number;
};

export const FUTURES_CHART_WINDOWS: Record<
  FuturesChartInterval,
  FuturesChartWindow
> = {
  '5m': {
    interval: '5m',
    range: '2d',
    intervalMs: 5 * MINUTE_MS,
    rangeMs: 2 * DAY_MS,
    maxLimit: 600,
    delivery: 'provider',
    freshMs: 15_000,
  },
  '15m': {
    interval: '15m',
    range: '3d',
    intervalMs: 15 * MINUTE_MS,
    rangeMs: 3 * DAY_MS,
    maxLimit: 300,
    delivery: 'provider',
    freshMs: 30_000,
  },
  '30m': {
    interval: '30m',
    range: '14d',
    intervalMs: 30 * MINUTE_MS,
    rangeMs: 14 * DAY_MS,
    maxLimit: 700,
    delivery: 'provider',
    freshMs: 30_000,
  },
  '1h': {
    interval: '1h',
    range: '14d',
    intervalMs: HOUR_MS,
    rangeMs: 14 * DAY_MS,
    maxLimit: 350,
    delivery: 'provider',
    freshMs: 60_000,
  },
  '4h': {
    interval: '4h',
    range: '96d',
    intervalMs: 4 * HOUR_MS,
    rangeMs: 96 * DAY_MS,
    // The stored path keeps its original 1..1000 limit contract.
    maxLimit: 1000,
    delivery: 'stored',
    freshMs: 5_000,
  },
  '1d': {
    interval: '1d',
    range: '1y',
    intervalMs: DAY_MS,
    rangeMs: 365 * DAY_MS,
    maxLimit: 400,
    delivery: 'provider',
    freshMs: 120_000,
  },
};

/** The default limit of the stored 4h path (the app sends 600). */
export const FUTURES_STORED_DEFAULT_LIMIT = 600;

export function isFuturesChartInterval(
  value: string,
): value is FuturesChartInterval {
  return (FUTURES_CHART_INTERVALS as readonly string[]).includes(value);
}

/**
 * Start of the bucket containing `nowMs`. Every interval here divides a UTC
 * day, and the epoch is a UTC midnight, so plain flooring is the UTC grid
 * Binance uses (1d buckets open at 00:00 UTC).
 */
export function futuresBucketStart(nowMs: number, intervalMs: number): number {
  return Math.floor(nowMs / intervalMs) * intervalMs;
}

/**
 * The rows a provider read covers: every bucket whose open lies in
 * [bucketStart(now) − range, bucketStart(now)], i.e. the completed buckets of
 * the window plus the current one. Always within Binance's 1000-row page.
 */
export function futuresProviderWindow(
  window: FuturesChartWindow,
  nowMs: number,
): { fromMs: number; toMs: number; rows: number; currentStartMs: number } {
  const currentStartMs = futuresBucketStart(nowMs, window.intervalMs);
  const rows = Math.floor(window.rangeMs / window.intervalMs) + 1;
  return {
    fromMs: currentStartMs - (rows - 1) * window.intervalMs,
    toMs: currentStartMs + window.intervalMs,
    rows,
    currentStartMs,
  };
}

/**
 * A provider read serves later viewers while it is younger than the
 * interval's freshness AND no bucket boundary has passed since it was taken —
 * after a boundary the cached copy lacks the new bucket and still holds the
 * previous one as open. A read taken after this request's own clock reading
 * (by a concurrent request) is as new as anything this request could fetch.
 */
export function isProviderReadCurrent(
  window: FuturesChartWindow,
  fetchedAtMs: number,
  nowMs: number,
): boolean {
  const age = nowMs - fetchedAtMs;
  if (age <= 0) return true;
  return (
    age < window.freshMs &&
    futuresBucketStart(fetchedAtMs, window.intervalMs) ===
      futuresBucketStart(nowMs, window.intervalMs)
  );
}
