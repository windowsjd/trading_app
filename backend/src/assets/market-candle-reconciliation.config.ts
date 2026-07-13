export const MARKET_CANDLE_RECONCILIATION_CONFIG = Symbol(
  'MARKET_CANDLE_RECONCILIATION_CONFIG',
);

export type ReconciliationMarketSchedule = {
  enabled: boolean;
  time: string;
  graceMinutes: number;
};

export type MarketCandleReconciliationConfig = {
  enabled: boolean;
  krx: ReconciliationMarketSchedule;
  us: ReconciliationMarketSchedule;
  crypto: {
    enabled: boolean;
    intervalSeconds: number;
  };
  lookbackBuckets: number;
  startupCatchUpEnabled: boolean;
  maxCatchUpHours: number;
  maxAssets: number;
  maxPages: number;
};

export class MarketCandleReconciliationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketCandleReconciliationConfigError';
  }
}

export function readMarketCandleReconciliationConfig(
  env: NodeJS.ProcessEnv = process.env,
): MarketCandleReconciliationConfig {
  const krxEnabled = bool(env, 'CANDLE_RECONCILIATION_KRX_ENABLED', false);
  const usEnabled = bool(env, 'CANDLE_RECONCILIATION_US_ENABLED', false);
  const cryptoEnabled = bool(
    env,
    'CANDLE_RECONCILIATION_CRYPTO_ENABLED',
    false,
  );
  const enabled = bool(env, 'CANDLE_RECONCILIATION_ENABLED', false);
  const config: MarketCandleReconciliationConfig = {
    enabled: enabled || krxEnabled || usEnabled || cryptoEnabled,
    krx: {
      enabled: krxEnabled,
      time: time(env, 'CANDLE_RECONCILIATION_KRX_TIME', '16:00'),
      graceMinutes: int(
        env,
        'CANDLE_RECONCILIATION_KRX_GRACE_MINUTES',
        20,
        1,
        720,
      ),
    },
    us: {
      enabled: usEnabled,
      time: time(env, 'CANDLE_RECONCILIATION_US_TIME', '16:30'),
      graceMinutes: int(
        env,
        'CANDLE_RECONCILIATION_US_GRACE_MINUTES',
        20,
        1,
        720,
      ),
    },
    crypto: {
      enabled: cryptoEnabled,
      intervalSeconds: int(
        env,
        'CANDLE_RECONCILIATION_CRYPTO_INTERVAL_SECONDS',
        300,
        60,
        86_400,
      ),
    },
    lookbackBuckets: int(
      env,
      'CANDLE_RECONCILIATION_LOOKBACK_BUCKETS',
      24,
      1,
      2_016,
    ),
    startupCatchUpEnabled: bool(
      env,
      'CANDLE_RECONCILIATION_STARTUP_CATCH_UP_ENABLED',
      false,
    ),
    maxCatchUpHours: int(
      env,
      'CANDLE_RECONCILIATION_MAX_CATCH_UP_HOURS',
      72,
      1,
      720,
    ),
    maxAssets: int(env, 'CANDLE_RECONCILIATION_MAX_ASSETS', 200, 1, 1_000),
    maxPages: int(env, 'CANDLE_RECONCILIATION_MAX_PAGES', 10, 1, 100),
  };
  return config;
}

function bool(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new MarketCandleReconciliationConfigError(
    `${name} must be true, false, 1, or 0.`,
  );
}

function int(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/u.test(value)) throw invalidInt(name, min, max);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalidInt(name, min, max);
  }
  return parsed;
}

function time(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new MarketCandleReconciliationConfigError(
      `${name} must be HH:MM in the range 00:00-23:59.`,
    );
  }
  return value;
}

function invalidInt(name: string, min: number, max: number) {
  return new MarketCandleReconciliationConfigError(
    `${name} must be an integer between ${min} and ${max}.`,
  );
}
