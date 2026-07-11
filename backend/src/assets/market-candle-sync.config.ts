export const DEFAULT_MARKET_CANDLE_SYNC_MAX_PAGES = 300;
export const MAX_MARKET_CANDLE_SYNC_MAX_PAGES = 5_000;
export const DEFAULT_MARKET_CANDLE_SYNC_MAX_ROWS = 50_000;
export const MAX_MARKET_CANDLE_SYNC_MAX_ROWS = 500_000;
export const DEFAULT_MARKET_CANDLE_SYNC_MAX_DURATION_MS = 180_000;
export const MAX_MARKET_CANDLE_SYNC_MAX_DURATION_MS = 3_600_000;
export const DEFAULT_MARKET_CANDLE_SYNC_ASSET_CONCURRENCY = 2;
// Bounded so a sync run can never fan out into unlimited parallel provider
// calls. KIS-backed assets are additionally forced to run sequentially.
export const MAX_MARKET_CANDLE_SYNC_ASSET_CONCURRENCY = 8;
export const DEFAULT_MARKET_CANDLE_SYNC_INCREMENTAL_OVERLAP_MINUTES = 120;
export const MAX_MARKET_CANDLE_SYNC_INCREMENTAL_OVERLAP_MINUTES = 20_160;
export const DEFAULT_MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS = 120;
export const MIN_MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS = 10;
export const MAX_MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS = 3_600;
export const DEFAULT_MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS = 40;
export const MIN_MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS = 5;

// Nest DI token: AssetsModule provides the env-derived config through it.
export const MARKET_CANDLE_SYNC_CONFIG = 'MARKET_CANDLE_SYNC_CONFIG';

export class MarketCandleSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketCandleSyncConfigError';
  }
}

export type MarketCandleSyncConfig = {
  // Per feed run (one asset/interval): provider page budget.
  maxPages: number;
  // Per feed run: accepted-row budget.
  maxRows: number;
  // Per feed run: wall-clock budget in milliseconds.
  maxDurationMs: number;
  // Parallel asset fan-out for non-KIS (crypto) assets. KIS-backed assets
  // always run one at a time on top of the shared KIS rate limiter.
  assetConcurrency: number;
  // Incremental mode re-fetches this much history before the latest stored
  // candle so provider-side revisions of recent rows are picked up.
  incrementalOverlapMinutes: number;
  lockTtlSeconds: number;
  lockRenewSeconds: number;
};

type Env = Record<string, string | undefined>;

export function readMarketCandleSyncConfig(
  env: Env = process.env,
): MarketCandleSyncConfig {
  const maxPages = readBoundedInteger(
    env.MARKET_CANDLE_SYNC_MAX_PAGES,
    DEFAULT_MARKET_CANDLE_SYNC_MAX_PAGES,
    'MARKET_CANDLE_SYNC_MAX_PAGES',
    1,
    MAX_MARKET_CANDLE_SYNC_MAX_PAGES,
  );
  const maxRows = readBoundedInteger(
    env.MARKET_CANDLE_SYNC_MAX_ROWS,
    DEFAULT_MARKET_CANDLE_SYNC_MAX_ROWS,
    'MARKET_CANDLE_SYNC_MAX_ROWS',
    1,
    MAX_MARKET_CANDLE_SYNC_MAX_ROWS,
  );
  const maxDurationMs = readBoundedInteger(
    env.MARKET_CANDLE_SYNC_MAX_DURATION_MS,
    DEFAULT_MARKET_CANDLE_SYNC_MAX_DURATION_MS,
    'MARKET_CANDLE_SYNC_MAX_DURATION_MS',
    1_000,
    MAX_MARKET_CANDLE_SYNC_MAX_DURATION_MS,
  );
  const assetConcurrency = readBoundedInteger(
    env.MARKET_CANDLE_SYNC_ASSET_CONCURRENCY,
    DEFAULT_MARKET_CANDLE_SYNC_ASSET_CONCURRENCY,
    'MARKET_CANDLE_SYNC_ASSET_CONCURRENCY',
    1,
    MAX_MARKET_CANDLE_SYNC_ASSET_CONCURRENCY,
  );
  const incrementalOverlapMinutes = readBoundedInteger(
    env.MARKET_CANDLE_SYNC_INCREMENTAL_OVERLAP_MINUTES,
    DEFAULT_MARKET_CANDLE_SYNC_INCREMENTAL_OVERLAP_MINUTES,
    'MARKET_CANDLE_SYNC_INCREMENTAL_OVERLAP_MINUTES',
    1,
    MAX_MARKET_CANDLE_SYNC_INCREMENTAL_OVERLAP_MINUTES,
  );
  const lockTtlSeconds = readBoundedInteger(
    env.MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS,
    DEFAULT_MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS,
    'MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS',
    MIN_MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS,
    MAX_MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS,
  );
  const lockRenewSeconds = readBoundedInteger(
    env.MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS,
    DEFAULT_MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS,
    'MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS',
    MIN_MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS,
    MAX_MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS,
  );
  if (lockRenewSeconds >= lockTtlSeconds) {
    throw new MarketCandleSyncConfigError(
      'MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS must be smaller than MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS.',
    );
  }
  return {
    maxPages,
    maxRows,
    maxDurationMs,
    assetConcurrency,
    incrementalOverlapMinutes,
    lockTtlSeconds,
    lockRenewSeconds,
  };
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    throw new MarketCandleSyncConfigError(
      `${name} must be a positive integer.`,
    );
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new MarketCandleSyncConfigError(
      `${name} must be between ${min} and ${max}.`,
    );
  }
  return parsed;
}
