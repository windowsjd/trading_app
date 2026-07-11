import { MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT } from './market-candle-retention.constants';

export const DEFAULT_MARKET_CANDLE_RETENTION_DAYS = 35;
export const MIN_MARKET_CANDLE_RETENTION_DAYS = 31;
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
  return {
    retentionDays,
    batchSize,
    maxBatches: DEFAULT_MARKET_CANDLE_RETENTION_MAX_BATCHES,
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
