import {
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
} from './redis.constants';
import type { RedisConfig } from './redis.types';

export type RedisEnv = Record<string, string | undefined>;

// Programmer/config error (invalid env value). Fails fast at startup rather
// than being silently defaulted, matching the provider env validation style.
export class RedisConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisConfigError';
  }
}

function readOptionalTrimmed(env: RedisEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readPositiveInteger(
  env: RedisEnv,
  name: string,
  defaultValue: number,
): number {
  const value = readOptionalTrimmed(env, name);
  if (value === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw new RedisConfigError(`${name} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RedisConfigError(`${name} must be a positive integer.`);
  }

  return parsed;
}

export function readRedisConfig(env: RedisEnv = process.env): RedisConfig {
  return {
    url: readOptionalTrimmed(env, 'REDIS_URL'),
    connectTimeoutMs: readPositiveInteger(
      env,
      'REDIS_CONNECT_TIMEOUT_MS',
      DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    ),
    commandTimeoutMs: readPositiveInteger(
      env,
      'REDIS_COMMAND_TIMEOUT_MS',
      DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
    ),
  };
}
