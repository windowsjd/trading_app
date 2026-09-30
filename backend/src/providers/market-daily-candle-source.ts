import { BINANCE_CANDLE_SOURCE } from './binance/binance-candle.types';
import { KIS_DOMESTIC_PERIOD_SOURCE } from './kis/candles/kis-period-candle.types';

/** Current eligible stored daily-candle origins for display change rate. */
export const MARKET_DAILY_CANDLE_SOURCE = {
  domesticStock: KIS_DOMESTIC_PERIOD_SOURCE,
  crypto: BINANCE_CANDLE_SOURCE,
} as const;
