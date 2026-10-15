// Chart timeframe policy for the asset detail candlestick chart. Pure module
// (no React/RN imports) so it can be unit-tested under `node --test`.
//
// Ranges map to backend window semantics:
//   - 'prev_open'  = previous regular market open → now
//                    (KRX 09:00 KST / US 09:30 ET / crypto 09:00 KST anchor)
//   - 'prev2_open' = two market days back, regular open → now
//   - '3d'         = rolling 3 days → now
//   - '14d'        = rolling 14 days → now
//   - '30d'        = rolling 30 days → now
//   - '1y'         = rolling 365 days → now (Binance max window; KIS returns
//                    whatever its retention allows)
//   - '96d'        = long-range 4h window (4h only):
//                    stocks (KRX and US) = the 96 most recent completed
//                    sessions + today on the exchange calendar,
//                    crypto = rolling 96 × 24h → now
//   - 'prevN_open' = (KRX only, N = 3/6/12/24/576) the regular open of the
//                    N-th actual KRX session before today's KST date → now
//                    (N sessions on a holiday, N + 1 while trading). These
//                    are the confirmed KRX chart windows (KOSCOM 100-stock
//                    design v2.1 §5.1); they need the backend that accepts
//                    the tokens (an older backend answers 400).
//
// 15m/30m/1h are aggregated by the backend from the stored 5m feed (45-day
// retention), so their windows are bounded by that retention, not by a
// provider page size. The 4h tab of KRX stocks and crypto reads the stored
// COMPLETED 4h history (180-day retention) plus the live 5m-aggregated recent
// buckets. US stocks request the same 96-session window (2026-10-14); the
// server answers with whatever real candles it holds (a shorter chart when
// history is partial — never padded).
//
// 1m was removed from the chart on purpose: KIS same-day minute data is capped
// at 30 rows, which cannot draw a meaningful 1m chart. The backend still
// accepts interval=1m for compatibility, but the UI must not offer it.
//
// 1w is not charted (design v2.1 §5.5): the tab is gone for every market.
// The backend keeps answering interval=1w for installed older apps.

export type AssetCandleRange =
  | '1d'
  | '3d'
  | '7d'
  | '14d'
  | '30d'
  | 'prev_open'
  | 'prev2_open'
  | 'prev3_open'
  | 'prev6_open'
  | 'prev12_open'
  | 'prev24_open'
  | 'prev576_open'
  | '1y'
  | 'season'
  | '96d';

export type AssetCandleInterval =
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '4h'
  | '1d'
  | '1w';

export type AssetChartTimeframe = {
  label: AssetCandleInterval;
  interval: AssetCandleInterval;
  range: AssetCandleRange;
  limit: number;
};

// Limits are sized from the worst-case expected candle count for the window
// (crypto trades 24/7, so it is always the upper bound); stocks return fewer
// because they only trade during the regular session. All stay within the
// Binance 1000-row single-call cap.
export const ASSET_CHART_TIMEFRAMES: AssetChartTimeframe[] = [
  // ~2 days × 288 5m-candles/day = 576
  { label: '5m', interval: '5m', range: 'prev_open', limit: 600 },
  // 3 days × 96 = 288 (crypto upper bound). A rolling 3-day window rather than
  // 'prev_open': the market-open anchor gave stocks barely a session and a
  // half, which is too short to read a 15m chart.
  { label: '15m', interval: '15m', range: '3d', limit: 288 },
  // 14 days × 48 = 672 (crypto upper bound)
  { label: '30m', interval: '30m', range: '14d', limit: 672 },
  // 14 days × 24 = 336 (crypto upper bound)
  { label: '1h', interval: '1h', range: '14d', limit: 336 },
  // 30 days × 6 = 180
  { label: '4h', interval: '4h', range: '30d', limit: 200 },
  // ~366 daily candles per year
  { label: '1d', interval: '1d', range: '1y', limit: 400 },
];

export const DEFAULT_ASSET_CHART_TIMEFRAME = ASSET_CHART_TIMEFRAMES[0];

// KRX/US: ≤ 96 sessions × 2 + today's 2 = 194; crypto: 96 × 6 = 576 closed +
// the current bucket = 577. One limit covers all and stays under the 1000 cap.
export const LONG_RANGE_FOUR_HOUR_TIMEFRAME: AssetChartTimeframe = {
  label: '4h',
  interval: '4h',
  range: '96d',
  limit: 600,
};

const LONG_RANGE_ASSET_TYPES: ReadonlySet<string> = new Set([
  'domestic_stock',
  'us_stock',
  'crypto',
]);

// KRX session windows (design v2.1 §5.1): N sessions + today. Limits cover
// N + 1 sessions — 5m 4 × 78 = 312, 15m 7 × 26 = 182, 30m 13 × 13 = 169,
// 1h 25 × 7 = 175, 1d 577 — under the 600/288/672/336/600 caps.
const KRX_SESSION_TIMEFRAMES: Partial<
  Record<AssetCandleInterval, AssetChartTimeframe>
> = {
  '5m': { label: '5m', interval: '5m', range: 'prev3_open', limit: 600 },
  '15m': { label: '15m', interval: '15m', range: 'prev6_open', limit: 288 },
  '30m': { label: '30m', interval: '30m', range: 'prev12_open', limit: 672 },
  '1h': { label: '1h', interval: '1h', range: 'prev24_open', limit: 336 },
  '1d': { label: '1d', interval: '1d', range: 'prev576_open', limit: 600 },
};

/**
 * The request window for a selected tab: KRX stocks use the session
 * windows, the 4h tab of every supported market the long-range window, and
 * everything else the base list. Returns null while the asset type is still
 * unknown so the caller waits instead of fetching (and caching) the wrong
 * window.
 */
export function resolveAssetChartTimeframe(
  timeframe: AssetChartTimeframe,
  assetType: string | null | undefined,
): AssetChartTimeframe | null {
  if (!assetType) return null;
  if (timeframe.interval === '4h')
    return LONG_RANGE_ASSET_TYPES.has(assetType)
      ? LONG_RANGE_FOUR_HOUR_TIMEFRAME
      : timeframe;
  if (assetType === 'domestic_stock')
    return KRX_SESSION_TIMEFRAMES[timeframe.interval] ?? timeframe;
  return timeframe;
}
