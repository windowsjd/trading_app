import { MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT } from './market-candle-retention.constants';

// Design v2.1 §5.2: ≥ the 45-day managed 5m range (KRX 1h 24 sessions).
export const DEFAULT_MARKET_CANDLE_RETENTION_DAYS = 45;
export const MIN_MARKET_CANDLE_RETENTION_DAYS = 31;
// Long-range completed 4h history (market_candles '4h' and the USDⓈ-M
// futures_market_candles). 180 calendar days by policy; never below 150, which
// still covers the 96-session KRX window (~147 calendar days across holidays).
export const DEFAULT_FOUR_HOUR_RETENTION_DAYS = 180;
export const MIN_FOUR_HOUR_RETENTION_DAYS = 150;
export const DEFAULT_MARKET_CANDLE_RETENTION_BATCH_SIZE = 5000;
export const DEFAULT_MARKET_CANDLE_RETENTION_MAX_BATCHES = 1000;

export class MarketCandleRetentionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketCandleRetentionConfigError';
  }
}

export type MarketCandleRetentionConfig = {
  retentionDays: number;
  batchSize: number;
  maxBatches: number;
  /** Long-range 4h retention; defaults to DEFAULT_FOUR_HOUR_RETENTION_DAYS. */
  fourHourRetentionDays?: number;
};

type Env = Record<string, string | undefined>;

export function readMarketCandleRetentionConfig(
  env: Env = process.env,
): MarketCandleRetentionConfig {
  const retentionDays = readPositiveInteger(
    env.MARKET_CANDLE_5M_RETENTION_DAYS,
    DEFAULT_MARKET_CANDLE_RETENTION_DAYS,
    'MARKET_CANDLE_5M_RETENTION_DAYS',
  );
  if (retentionDays < MIN_MARKET_CANDLE_RETENTION_DAYS) {
    throw new MarketCandleRetentionConfigError(
      `MARKET_CANDLE_5M_RETENTION_DAYS must be at least ${MIN_MARKET_CANDLE_RETENTION_DAYS}.`,
    );
  }
  const batchSize = readPositiveInteger(
    env.MARKET_CANDLE_RETENTION_BATCH_SIZE,
    DEFAULT_MARKET_CANDLE_RETENTION_BATCH_SIZE,
    'MARKET_CANDLE_RETENTION_BATCH_SIZE',
  );
  if (batchSize > MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT) {
    throw new MarketCandleRetentionConfigError(
      `MARKET_CANDLE_RETENTION_BATCH_SIZE must be at most ${MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT}.`,
    );
  }
  const fourHourRetentionDays = readPositiveInteger(
    env.MARKET_CANDLE_4H_RETENTION_DAYS,
    DEFAULT_FOUR_HOUR_RETENTION_DAYS,
    'MARKET_CANDLE_4H_RETENTION_DAYS',
  );
  if (fourHourRetentionDays < MIN_FOUR_HOUR_RETENTION_DAYS) {
    // @diagnosticSurface internal: Startup/runner configuration guard; the message names only the public env key.
    throw new MarketCandleRetentionConfigError(
      `MARKET_CANDLE_4H_RETENTION_DAYS must be at least ${MIN_FOUR_HOUR_RETENTION_DAYS}.`,
    );
  }
  return {
    retentionDays,
    batchSize,
    maxBatches: DEFAULT_MARKET_CANDLE_RETENTION_MAX_BATCHES,
    fourHourRetentionDays,
  };
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    throw new MarketCandleRetentionConfigError(
      `${name} must be a positive integer.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MarketCandleRetentionConfigError(
      `${name} must be a positive integer.`,
    );
  }
  return parsed;
}
