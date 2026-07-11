import { createHash } from 'node:crypto';
import type {
  KisApiEnvironment,
  KisTrafficClass,
} from './kis-rate-limit.types';
import { KisRateLimitConfigError } from './kis-rate-limit.types';

export const DEFAULT_KIS_REAL_REST_MIN_INTERVAL_MS = 125;
export const DEFAULT_KIS_VIRTUAL_REST_MIN_INTERVAL_MS = 1000;
export const DEFAULT_KIS_OAUTH_MIN_INTERVAL_MS = 1000;
export const DEFAULT_KIS_RATE_LIMIT_MAX_WAIT_MS = 30_000;
export const DEFAULT_KIS_RATE_LIMIT_MAX_QUEUE_SIZE = 500;

export type KisRateLimitConfig = {
  enabled: boolean;
  environment: KisApiEnvironment;
  restMinIntervalMs: number;
  oauthMinIntervalMs: number;
  maxWaitMs: number;
  maxQueueSize: number;
  appKeyHash: string;
};

type Env = Record<string, string | undefined>;

export function readKisRateLimitConfig(
  env: Env = process.env,
): KisRateLimitConfig {
  const environment = readEnvironment(env.KIS_API_ENVIRONMENT);
  const restMinIntervalMs = readPositiveInteger(
    env.KIS_REST_MIN_INTERVAL_MS,
    environment === 'real'
      ? DEFAULT_KIS_REAL_REST_MIN_INTERVAL_MS
      : DEFAULT_KIS_VIRTUAL_REST_MIN_INTERVAL_MS,
    'KIS_REST_MIN_INTERVAL_MS',
  );
  const oauthMinIntervalMs = readPositiveInteger(
    env.KIS_OAUTH_MIN_INTERVAL_MS,
    DEFAULT_KIS_OAUTH_MIN_INTERVAL_MS,
    'KIS_OAUTH_MIN_INTERVAL_MS',
  );

  // 18/sec means an interval must be at least ceil(1000/18)=56ms.
  const minimumRest = environment === 'real' ? 56 : 1000;
  if (restMinIntervalMs < minimumRest) {
    throw new KisRateLimitConfigError(
      `KIS_REST_MIN_INTERVAL_MS must be at least ${minimumRest} for ${environment}.`,
    );
  }
  if (oauthMinIntervalMs < 1000) {
    throw new KisRateLimitConfigError(
      'KIS_OAUTH_MIN_INTERVAL_MS must be at least 1000.',
    );
  }

  return {
    enabled: readBoolean(env.KIS_RATE_LIMIT_ENABLED, true),
    environment,
    restMinIntervalMs,
    oauthMinIntervalMs,
    maxWaitMs: readPositiveInteger(
      env.KIS_RATE_LIMIT_MAX_WAIT_MS,
      DEFAULT_KIS_RATE_LIMIT_MAX_WAIT_MS,
      'KIS_RATE_LIMIT_MAX_WAIT_MS',
    ),
    maxQueueSize: readPositiveInteger(
      env.KIS_RATE_LIMIT_MAX_QUEUE_SIZE,
      DEFAULT_KIS_RATE_LIMIT_MAX_QUEUE_SIZE,
      'KIS_RATE_LIMIT_MAX_QUEUE_SIZE',
    ),
    // Only this irreversible prefix enters Redis keys. The original credential
    // is neither stored in this config nor logged.
    appKeyHash: createHash('sha256')
      .update(env.KIS_APP_KEY?.trim() || 'unconfigured')
      .digest('hex')
      .slice(0, 16),
  };
}

export function intervalFor(
  config: KisRateLimitConfig,
  trafficClass: KisTrafficClass,
): number {
  return trafficClass === 'oauth'
    ? config.oauthMinIntervalMs
    : config.restMinIntervalMs;
}

function readEnvironment(value: string | undefined): KisApiEnvironment {
  const normalized = value?.trim() || 'real';
  if (normalized !== 'real' && normalized !== 'virtual') {
    throw new KisRateLimitConfigError(
      'KIS_API_ENVIRONMENT must be real or virtual.',
    );
  }
  return normalized;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new KisRateLimitConfigError(
    'KIS_RATE_LIMIT_ENABLED must be true, false, 1, or 0.',
  );
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    throw new KisRateLimitConfigError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new KisRateLimitConfigError(`${name} must be a positive integer.`);
  }
  return parsed;
}
