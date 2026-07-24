/**
 * Configuration for the scheduler-based limit-order matching job (paths A/B).
 *
 * This is the ONE parser for these variables, owned by the orders feature and
 * reused by both the Ops scheduler config and startup env validation. Values
 * are validated strictly: a typo or an out-of-range number refuses to boot
 * rather than silently degrading how user cash is matched.
 *
 * Deliberately dependency-free (no import from ops-config) so it can be read
 * from ops-config, env-validation, and the matching service without a cycle.
 */

/** Matcher polls this often; small enough that a fresh snapshot stays fresh. */
export const DEFAULT_LIMIT_ORDER_MATCHING_INTERVAL_MS = 5_000;
/** Orders processed per matching cycle before the rest roll to the next tick. */
export const DEFAULT_LIMIT_ORDER_MATCH_BATCH_SIZE = 200;
/** Path-B closed candles older than this are never used (no outage backfill). */
export const DEFAULT_LIMIT_ORDER_CANDLE_LOOKBACK_MS = 900_000; // 15 minutes

/**
 * Asset-price execute freshness is a hardcoded 10s policy constant
 * (providers/realtime-execution-policy.ts, resolveExecuteFreshnessThresholdSeconds).
 * The matching interval must be at most HALF of it so ordinary scheduler jitter
 * can never let a snapshot the matcher just accepted age past the freshness
 * window before the fill commits.
 */
export const LIMIT_ORDER_EXECUTE_FRESHNESS_MS = 10_000;
export const MAX_LIMIT_ORDER_MATCHING_INTERVAL_MS =
  LIMIT_ORDER_EXECUTE_FRESHNESS_MS / 2;
/** A sub-second cadence would hammer the DB without helping a 5s-fresh price. */
export const MIN_LIMIT_ORDER_MATCHING_INTERVAL_MS = 1_000;
export const MAX_LIMIT_ORDER_MATCH_BATCH_SIZE = 1_000;
/** A lookback shorter than one candle would make path B unable to see any. */
export const MIN_LIMIT_ORDER_CANDLE_LOOKBACK_MS = 300_000; // one 5m window
export const MAX_LIMIT_ORDER_CANDLE_LOOKBACK_MS = 86_400_000; // 1 day ceiling

export class LimitOrderMatchingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitOrderMatchingConfigError';
  }
}

export type LimitOrderMatchingConfig = {
  /** SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED — default false. */
  matchingEnabled: boolean;
  /** LIMIT_ORDER_MATCHING_INTERVAL_MS. */
  intervalMs: number;
  /** LIMIT_ORDER_MATCH_BATCH_SIZE. */
  batchSize: number;
  /** LIMIT_ORDER_CANDLE_LOOKBACK_MS. */
  candleLookbackMs: number;
};

const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0']);

function parseStrictBoolean(raw: string | undefined, name: string): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new LimitOrderMatchingConfigError(
    `${name} must be one of true, false, 1, 0 (case-insensitive), or be omitted for the default false. Received: ${JSON.stringify(raw)}.`,
  );
}

function parseBoundedInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new LimitOrderMatchingConfigError(
      `${name} must be a positive integer between ${min} and ${max}. Received: ${JSON.stringify(raw)}.`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new LimitOrderMatchingConfigError(
      `${name} must be a positive integer between ${min} and ${max}. Received: ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

/**
 * Strict read of the matching configuration. Throws
 * LimitOrderMatchingConfigError on any invalid value, which startup validation
 * (src/common/env-validation.ts) turns into a refusal to boot.
 */
export function readLimitOrderMatchingConfig(
  env: NodeJS.ProcessEnv = process.env,
): LimitOrderMatchingConfig {
  const matchingEnabled = parseStrictBoolean(
    env.SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED,
    'SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED',
  );
  const intervalMs = parseBoundedInteger(
    env.LIMIT_ORDER_MATCHING_INTERVAL_MS,
    'LIMIT_ORDER_MATCHING_INTERVAL_MS',
    DEFAULT_LIMIT_ORDER_MATCHING_INTERVAL_MS,
    MIN_LIMIT_ORDER_MATCHING_INTERVAL_MS,
    MAX_LIMIT_ORDER_MATCHING_INTERVAL_MS,
  );
  const batchSize = parseBoundedInteger(
    env.LIMIT_ORDER_MATCH_BATCH_SIZE,
    'LIMIT_ORDER_MATCH_BATCH_SIZE',
    DEFAULT_LIMIT_ORDER_MATCH_BATCH_SIZE,
    1,
    MAX_LIMIT_ORDER_MATCH_BATCH_SIZE,
  );
  const candleLookbackMs = parseBoundedInteger(
    env.LIMIT_ORDER_CANDLE_LOOKBACK_MS,
    'LIMIT_ORDER_CANDLE_LOOKBACK_MS',
    DEFAULT_LIMIT_ORDER_CANDLE_LOOKBACK_MS,
    MIN_LIMIT_ORDER_CANDLE_LOOKBACK_MS,
    MAX_LIMIT_ORDER_CANDLE_LOOKBACK_MS,
  );

  return { matchingEnabled, intervalMs, batchSize, candleLookbackMs };
}
