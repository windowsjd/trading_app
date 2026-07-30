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
  coverageTailToleranceMs: number;
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
  // `database` is the normal serving mode: 15m/30m/1h/4h are aggregated from
  // the stored 5m feed at read time, so a provider-direct answer for them can
  // only be a truncated single page. `legacy` stays available as the explicit
  // emergency rollback switch.
  // A blank value is "not configured" (an empty `.env` line), not a typo.
  const rawMode = env.CANDLE_SERVING_MODE?.trim().toLowerCase() || 'database';
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
    // Sized so one on-demand repair can sweep the WHOLE 15m/3d source window
    // (3d + 4h padding can span up to 4 KRX sessions ≈ ~1,530 domestic 1m
    // rows ≈ 13 pages at 120 rows/page). The sweep pages backward from the
    // newest edge, so a budget smaller than the window leaves the oldest
    // chunk permanently unfetched — every retry re-reads the same newest
    // pages and stops at the same boundary.
    onDemandRefreshMaxPages: readPositiveInteger(
      env,
      'CANDLE_SERVING_ON_DEMAND_REFRESH_MAX_PAGES',
      15,
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
    // Must cover the largest chart window that is expected to SELF-HEAL on
    // demand: the 15m tab requests range=3d, whose aggregated read plan spans
    // 3d + 4h of source padding. With the old 2-day default that request
    // could never start a repair — a cold asset answered 503
    // (baseline_not_ready) or froze at whatever short window the store held
    // (cold_baseline_partial_window). 30m/1h/4h (14d/30d) stay ABOVE this
    // bound on purpose: those windows are seeded by the baseline job and kept
    // fresh by the scheduled incremental sync, not by request-time repair.
    maxOnDemandRepairRangeMs: readPositiveInteger(
      env,
      'CANDLE_SERVING_ON_DEMAND_REPAIR_MAX_RANGE_MS',
      4 * DAY_MS,
    ),
    // A checkpoint confirms coverage only up to its own finish time, so a
    // window is "not confirmed to now" one minute after a sync completes.
    // Within this tolerance the history still counts as covered and the
    // recent tail is refreshed by the normal bounded sync instead of failing
    // the whole request. Default: one day, which spans an overnight gap
    // between operator/incremental syncs.
    coverageTailToleranceMs: readPositiveInteger(
      env,
      'CANDLE_SERVING_COVERAGE_TAIL_TOLERANCE_MS',
      DAY_MS,
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
