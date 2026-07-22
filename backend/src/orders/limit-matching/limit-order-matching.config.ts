import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { parseLimitOrderEnabled } from '../limit-order.config';

export const DEFAULT_LIMIT_ORDER_EVENT_STREAM_KEY =
  'limit-order:price-events:v1';
export const DEFAULT_LIMIT_ORDER_EVENT_CONSUMER_GROUP =
  'limit-order-matchers:v1';

export type LimitOrderMatchingConfig = {
  enabled: boolean;
  streamKey: string;
  dlqStreamKey: string;
  consumerGroup: string;
  consumerName: string;
  blockMs: number;
  eventReadBatchSize: number;
  candidateBatchSize: number;
  eventMaxLen: number;
  pendingIdleMs: number;
  reclaimIntervalMs: number;
  heartbeatIntervalMs: number;
  healthMaxAgeMs: number;
  leaderRetryMs: number;
};

export class LimitOrderMatchingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitOrderMatchingConfigError';
  }
}

export function readLimitOrderMatchingConfig(
  env: NodeJS.ProcessEnv = process.env,
): LimitOrderMatchingConfig {
  const enabled = parseLimitOrderEnabled(
    env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED,
    'LIMIT_ORDER_AUTO_EXECUTION_ENABLED',
  );
  const streamKey = readText(
    env.LIMIT_ORDER_EVENT_STREAM_KEY,
    DEFAULT_LIMIT_ORDER_EVENT_STREAM_KEY,
    'LIMIT_ORDER_EVENT_STREAM_KEY',
  );
  const consumerGroup = readText(
    env.LIMIT_ORDER_EVENT_CONSUMER_GROUP,
    DEFAULT_LIMIT_ORDER_EVENT_CONSUMER_GROUP,
    'LIMIT_ORDER_EVENT_CONSUMER_GROUP',
  );
  const config: LimitOrderMatchingConfig = {
    enabled,
    streamKey,
    dlqStreamKey: `${streamKey}:dlq`,
    consumerGroup,
    consumerName: `${hostname()}:${process.pid}:${randomUUID()}`,
    blockMs: readInteger(env, 'LIMIT_ORDER_EVENT_BLOCK_MS', 3000, 250, 30_000),
    eventReadBatchSize: readInteger(
      env,
      'LIMIT_ORDER_EVENT_READ_BATCH_SIZE',
      100,
      1,
      1000,
    ),
    candidateBatchSize: readInteger(
      env,
      'LIMIT_ORDER_CANDIDATE_BATCH_SIZE',
      100,
      1,
      1000,
    ),
    eventMaxLen: readInteger(
      env,
      'LIMIT_ORDER_EVENT_MAXLEN',
      100_000,
      1000,
      10_000_000,
    ),
    pendingIdleMs: readInteger(
      env,
      'LIMIT_ORDER_PENDING_IDLE_MS',
      30_000,
      1000,
      3_600_000,
    ),
    reclaimIntervalMs: readInteger(
      env,
      'LIMIT_ORDER_RECLAIM_INTERVAL_MS',
      30_000,
      1000,
      3_600_000,
    ),
    heartbeatIntervalMs: readInteger(
      env,
      'LIMIT_ORDER_MATCHER_HEARTBEAT_INTERVAL_MS',
      5000,
      500,
      300_000,
    ),
    healthMaxAgeMs: readInteger(
      env,
      'LIMIT_ORDER_MATCHER_HEALTH_MAX_AGE_MS',
      15_000,
      1000,
      600_000,
    ),
    leaderRetryMs: 2000,
  };

  if (config.healthMaxAgeMs <= config.heartbeatIntervalMs) {
    throw new LimitOrderMatchingConfigError(
      'LIMIT_ORDER_MATCHER_HEALTH_MAX_AGE_MS must be greater than LIMIT_ORDER_MATCHER_HEARTBEAT_INTERVAL_MS.',
    );
  }
  if (config.pendingIdleMs < config.blockMs) {
    throw new LimitOrderMatchingConfigError(
      'LIMIT_ORDER_PENDING_IDLE_MS must be greater than or equal to LIMIT_ORDER_EVENT_BLOCK_MS.',
    );
  }

  return config;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new LimitOrderMatchingConfigError(
      `${name} must be an integer between ${min} and ${max}. Received: ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

function readText(
  raw: string | undefined,
  fallback: string,
  name: string,
): string {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!value || value.length > 200 || /[\r\n\0]/u.test(value)) {
    throw new LimitOrderMatchingConfigError(
      `${name} must be a non-empty Redis key/group name of at most 200 characters.`,
    );
  }
  return value;
}
