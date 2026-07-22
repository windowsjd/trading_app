import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * Cross-instance provider trade readiness sharing.
 *
 * DEFAULT OFF. With it off, behaviour is exactly what it was before: readiness
 * is answered from this process's own registry and a non-owner instance fails
 * closed. Turning it on is what makes a multi-instance API deployment answer
 * consistently regardless of which pod served the request.
 */
export type ProviderTradeReadinessConfig = {
  enabled: boolean;
  /**
   * Key TTL. The owner republishes every `publishIntervalMs`; the TTL is the
   * heartbeat, so an owner that dies disappears from the shared view after at
   * most this long.
   */
  ttlSeconds: number;
  publishIntervalMs: number;
  /** Stable-per-process identity used for compare-and-swap ownership. */
  instanceId: string;
};

export class ProviderTradeReadinessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTradeReadinessConfigError';
  }
}

export function readProviderTradeReadinessConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProviderTradeReadinessConfig {
  const config: ProviderTradeReadinessConfig = {
    enabled: readBoolean(env, 'LIMIT_ORDER_SHARED_READINESS_ENABLED', false),
    ttlSeconds: readInteger(
      env,
      'LIMIT_ORDER_SHARED_READINESS_TTL_SECONDS',
      30,
      5,
      3600,
    ),
    publishIntervalMs: readInteger(
      env,
      'LIMIT_ORDER_SHARED_READINESS_PUBLISH_INTERVAL_MS',
      5_000,
      500,
      600_000,
    ),
    instanceId: readInstanceId(env),
  };

  // A TTL at or below the publish interval would expire the record between two
  // heartbeats and make a perfectly healthy owner look absent.
  if (config.ttlSeconds * 1000 <= config.publishIntervalMs * 2) {
    throw new ProviderTradeReadinessConfigError(
      'LIMIT_ORDER_SHARED_READINESS_TTL_SECONDS must exceed twice LIMIT_ORDER_SHARED_READINESS_PUBLISH_INTERVAL_MS.',
    );
  }

  return config;
}

function readInstanceId(env: NodeJS.ProcessEnv): string {
  const raw = env.LIMIT_ORDER_SHARED_READINESS_INSTANCE_ID?.trim();
  if (!raw) return `${hostname()}:${process.pid}:${randomUUID()}`;
  if (raw.length > 200 || /[\r\n\0]/u.test(raw)) {
    throw new ProviderTradeReadinessConfigError(
      'LIMIT_ORDER_SHARED_READINESS_INSTANCE_ID must be at most 200 characters and contain no control characters.',
    );
  }
  return raw;
}

function readBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new ProviderTradeReadinessConfigError(
    `${name} must be one of true, false, 1, 0 (case-insensitive), or be omitted for the default ${fallback}. Received: ${JSON.stringify(raw)}.`,
  );
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
    throw new ProviderTradeReadinessConfigError(
      `${name} must be an integer between ${min} and ${max}. Received: ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}
