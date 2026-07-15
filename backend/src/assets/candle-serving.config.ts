export type CandleServingMode = 'legacy' | 'database';

export type CandleServingConfig = {
  mode: CandleServingMode;
  currentFreshnessMs: number;
  onDemandRefreshEnabled: boolean;
  onDemandRefreshMaxDurationMs: number;
  onDemandRefreshMaxPages: number;
  onDemandRefreshMaxRows: number;
  staleWaiterMaxWaitMs: number;
  maxManagedFiveMinuteRangeMs: number;
  maxManagedPeriodRangeMs: number;
  maxOnDemandRepairRangeMs: number;
};

export const CANDLE_SERVING_CONFIG = Symbol('CANDLE_SERVING_CONFIG');

const DAY_MS = 24 * 60 * 60_000;

export class CandleServingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandleServingConfigError';
  }
}

type Env = Record<string, string | undefined>;

export function readCandleServingConfig(
  env: Env = process.env,
): CandleServingConfig {
  const rawMode = (env.CANDLE_SERVING_MODE ?? 'legacy').trim().toLowerCase();
  if (rawMode !== 'legacy' && rawMode !== 'database') {
    throw new CandleServingConfigError(
      'CANDLE_SERVING_MODE must be legacy or database.',
    );
  }

  return {
    mode: rawMode,
    currentFreshnessMs: readPositiveInteger(
      env,
      'CANDLE_SERVING_CURRENT_DB_FRESHNESS_MS',
      60_000,
    ),
    onDemandRefreshEnabled: readBoolean(
      env,
      'CANDLE_SERVING_ON_DEMAND_REFRESH_ENABLED',
      true,
    ),
    onDemandRefreshMaxDurationMs: readPositiveInteger(
      env,
      'CANDLE_SERVING_ON_DEMAND_REFRESH_MAX_DURATION_MS',
      15_000,
    ),
    onDemandRefreshMaxPages: readPositiveInteger(
      env,
      'CANDLE_SERVING_ON_DEMAND_REFRESH_MAX_PAGES',
      10,
    ),
    onDemandRefreshMaxRows: readPositiveInteger(
      env,
      'CANDLE_SERVING_ON_DEMAND_REFRESH_MAX_ROWS',
      5_000,
    ),
    staleWaiterMaxWaitMs: readPositiveInteger(
      env,
      'CANDLE_SERVING_STALE_WAITER_MAX_WAIT_MS',
      500,
    ),
    maxManagedFiveMinuteRangeMs: 35 * DAY_MS,
    maxManagedPeriodRangeMs: 365 * DAY_MS,
    maxOnDemandRepairRangeMs: readPositiveInteger(
      env,
      'CANDLE_SERVING_ON_DEMAND_REPAIR_MAX_RANGE_MS',
      2 * DAY_MS,
    ),
  };
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new CandleServingConfigError(`${name} must be true, false, 1, or 0.`);
}

function readPositiveInteger(env: Env, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/u.test(value)) {
    throw new CandleServingConfigError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CandleServingConfigError(`${name} must be a positive integer.`);
  }
  return parsed;
}
