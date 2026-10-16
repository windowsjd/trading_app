import { BINANCE_CANDLE_SOURCE } from './binance/binance-candle.types';
import { KIS_DOMESTIC_PERIOD_SOURCE } from './kis/candles/kis-period-candle.types';
import { TIINGO_EOD_CANDLE_SOURCE } from './tiingo/tiingo.config';

/**
 * Current eligible stored daily-candle origins for display change rate. US
 * stocks only on Tiingo (2026-10-17): the previous session's end-of-day RAW
 * close; KIS US daily rows are split/dividend-adjusted, so US on KIS has none.
 */
export const MARKET_DAILY_CANDLE_SOURCE = {
  domesticStock: KIS_DOMESTIC_PERIOD_SOURCE,
  crypto: BINANCE_CANDLE_SOURCE,
  usStock: TIINGO_EOD_CANDLE_SOURCE,
} as const;
