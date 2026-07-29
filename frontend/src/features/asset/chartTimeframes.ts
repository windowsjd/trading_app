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
//
// 15m/30m/1h/4h are aggregated by the backend from the stored 5m feed (35-day
// retention), so their windows are bounded by that retention, not by a
// provider page size.
//
// 1m was removed from the chart on purpose: KIS same-day minute data is capped
// at 30 rows, which cannot draw a meaningful 1m chart. The backend still
// accepts interval=1m for compatibility, but the UI must not offer it.

export type AssetCandleRange =
  | '1d'
  | '3d'
  | '7d'
  | '14d'
  | '30d'
  | 'prev_open'
  | 'prev2_open'
  | '1y'
  | 'season';

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
  // ~53 weekly candles per year
  { label: '1w', interval: '1w', range: '1y', limit: 60 },
];

export const DEFAULT_ASSET_CHART_TIMEFRAME = ASSET_CHART_TIMEFRAMES[0];
