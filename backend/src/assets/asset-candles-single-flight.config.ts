export const DEFAULT_CANDLE_SINGLE_FLIGHT_LOCK_TTL_MS = 30_000;
export const DEFAULT_CANDLE_SINGLE_FLIGHT_WAIT_TIMEOUT_MS = 35_000;
export const DEFAULT_CANDLE_SINGLE_FLIGHT_POLL_INTERVAL_MS = 100;
export const DEFAULT_CANDLE_SINGLE_FLIGHT_RENEW_INTERVAL_MS = 10_000;

export type CandleSingleFlightConfig = {
  lockTtlMs: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  renewIntervalMs: number;
};

export class CandleSingleFlightConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandleSingleFlightConfigError';
  }
}

type Env = Record<string, string | undefined>;

export function readCandleSingleFlightConfig(
  env: Env = process.env,
): CandleSingleFlightConfig {
  const config = {
    lockTtlMs: readPositive(
      env.CANDLE_SINGLE_FLIGHT_LOCK_TTL_MS,
      DEFAULT_CANDLE_SINGLE_FLIGHT_LOCK_TTL_MS,
      'CANDLE_SINGLE_FLIGHT_LOCK_TTL_MS',
    ),
    waitTimeoutMs: readPositive(
      env.CANDLE_SINGLE_FLIGHT_WAIT_TIMEOUT_MS,
      DEFAULT_CANDLE_SINGLE_FLIGHT_WAIT_TIMEOUT_MS,
      'CANDLE_SINGLE_FLIGHT_WAIT_TIMEOUT_MS',
    ),
    pollIntervalMs: readPositive(
      env.CANDLE_SINGLE_FLIGHT_POLL_INTERVAL_MS,
      DEFAULT_CANDLE_SINGLE_FLIGHT_POLL_INTERVAL_MS,
      'CANDLE_SINGLE_FLIGHT_POLL_INTERVAL_MS',
    ),
    renewIntervalMs: readPositive(
      env.CANDLE_SINGLE_FLIGHT_RENEW_INTERVAL_MS,
      DEFAULT_CANDLE_SINGLE_FLIGHT_RENEW_INTERVAL_MS,
      'CANDLE_SINGLE_FLIGHT_RENEW_INTERVAL_MS',
    ),
  };
  if (config.renewIntervalMs >= config.lockTtlMs) {
    throw new CandleSingleFlightConfigError(
      'CANDLE_SINGLE_FLIGHT_RENEW_INTERVAL_MS must be less than lock TTL.',
    );
  }
  return config;
}

function readPositive(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    throw new CandleSingleFlightConfigError(
      `${name} must be a positive integer.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CandleSingleFlightConfigError(
      `${name} must be a positive integer.`,
    );
  }
  return parsed;
}
