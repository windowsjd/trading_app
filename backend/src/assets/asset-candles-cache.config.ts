// Candle cache configuration (separate from Redis connection config). Defaults
// are conservative: the cache ships DISABLED because it is not yet wired into
// the serving path in this step. A later serving step turns it on explicitly.
export const DEFAULT_CANDLE_CACHE_ENABLED = false;
export const DEFAULT_CANDLE_CACHE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB

export type CandleCacheConfig = {
  enabled: boolean;
  maxPayloadBytes: number;
};

export type CandleCacheEnv = Record<string, string | undefined>;

// Programmer/config error (invalid env value). These are fail-fast at startup
// rather than silently defaulted, so a misconfigured deployment is visible.
export class CandleCacheConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandleCacheConfigError';
  }
}

function readOptionalTrimmed(
  env: CandleCacheEnv,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readBooleanFlag(
  env: CandleCacheEnv,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = readOptionalTrimmed(env, name);
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }

  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  throw new CandleCacheConfigError(`${name} must be true, false, 1, or 0.`);
}

function readPositiveInteger(
  env: CandleCacheEnv,
  name: string,
  defaultValue: number,
): number {
  const value = readOptionalTrimmed(env, name);
  if (value === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw new CandleCacheConfigError(`${name} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CandleCacheConfigError(`${name} must be a positive integer.`);
  }

  return parsed;
}

export function readCandleCacheConfig(
  env: CandleCacheEnv = process.env,
): CandleCacheConfig {
  return {
    enabled: readBooleanFlag(
      env,
      'CANDLE_CACHE_ENABLED',
      DEFAULT_CANDLE_CACHE_ENABLED,
    ),
    maxPayloadBytes: readPositiveInteger(
      env,
      'CANDLE_CACHE_MAX_PAYLOAD_BYTES',
      DEFAULT_CANDLE_CACHE_MAX_PAYLOAD_BYTES,
    ),
  };
}
