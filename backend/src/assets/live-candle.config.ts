export const LIVE_CANDLE_CONFIG = Symbol('LIVE_CANDLE_CONFIG');

export type LiveCandleConfig = {
  enabled: boolean;
  kisEnabled: boolean;
  kisUsDelayedEnabled: boolean;
  binanceEnabled: boolean;
  ownerLeaseTtlMs: number;
  ownerLeaseRenewMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  finalizeGraceMs: number;
  finalizerIntervalMs: number;
  staleThresholdMs: number;
  maxSubscriptionsPerClient: number;
  maxProviderSubscriptionsPerShard: number;
  stateTtlSeconds: number;
  maxFutureEventSkewMs: number;
  websocketBackpressureBytes: number;
  // Old-generation / deferred bucket recovery (bounded queue processing).
  recoveryMaxBatch: number;
  recoveryRetryMs: number;
  // Escape hatch for running live ingestion without its reconciliation
  // safety net. Never enable in production.
  allowWithoutReconciliation: boolean;
};

export class LiveCandleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCandleConfigError';
  }
}

export function readLiveCandleConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiveCandleConfig {
  const config: LiveCandleConfig = {
    enabled: boolean(env, 'CANDLE_LIVE_STREAMING_ENABLED', false),
    kisEnabled: boolean(env, 'CANDLE_LIVE_KIS_ENABLED', false),
    kisUsDelayedEnabled: boolean(
      env,
      'CANDLE_LIVE_KIS_US_DELAYED_ENABLED',
      false,
    ),
    binanceEnabled: boolean(env, 'CANDLE_LIVE_BINANCE_ENABLED', false),
    ownerLeaseTtlMs: integer(
      env,
      'CANDLE_LIVE_OWNER_LEASE_TTL_MS',
      30_000,
      2_000,
      300_000,
    ),
    ownerLeaseRenewMs: integer(
      env,
      'CANDLE_LIVE_OWNER_LEASE_RENEW_MS',
      10_000,
      500,
      120_000,
    ),
    reconnectMinMs: integer(
      env,
      'CANDLE_LIVE_RECONNECT_MIN_MS',
      1_000,
      100,
      300_000,
    ),
    reconnectMaxMs: integer(
      env,
      'CANDLE_LIVE_RECONNECT_MAX_MS',
      30_000,
      100,
      600_000,
    ),
    finalizeGraceMs: integer(
      env,
      'CANDLE_LIVE_FINALIZE_GRACE_MS',
      5_000,
      1,
      300_000,
    ),
    finalizerIntervalMs: integer(
      env,
      'CANDLE_LIVE_FINALIZER_INTERVAL_MS',
      1_000,
      100,
      60_000,
    ),
    staleThresholdMs: integer(
      env,
      'CANDLE_LIVE_STALE_THRESHOLD_MS',
      30_000,
      1,
      3_600_000,
    ),
    maxSubscriptionsPerClient: integer(
      env,
      'CANDLE_LIVE_MAX_SUBSCRIPTIONS_PER_CLIENT',
      20,
      1,
      200,
    ),
    maxProviderSubscriptionsPerShard: integer(
      env,
      'CANDLE_LIVE_MAX_PROVIDER_SUBSCRIPTIONS_PER_SHARD',
      200,
      1,
      1_024,
    ),
    stateTtlSeconds: integer(
      env,
      'CANDLE_LIVE_STATE_TTL_SECONDS',
      86_400,
      300,
      604_800,
    ),
    maxFutureEventSkewMs: integer(
      env,
      'CANDLE_LIVE_MAX_FUTURE_EVENT_SKEW_MS',
      10_000,
      1,
      300_000,
    ),
    websocketBackpressureBytes: integer(
      env,
      'CANDLE_LIVE_WS_BACKPRESSURE_BYTES',
      1_048_576,
      1_024,
      16_777_216,
    ),
    recoveryMaxBatch: integer(env, 'CANDLE_LIVE_RECOVERY_MAX_BATCH', 10, 1, 200),
    recoveryRetryMs: integer(
      env,
      'CANDLE_LIVE_RECOVERY_RETRY_MS',
      60_000,
      1_000,
      3_600_000,
    ),
    allowWithoutReconciliation: boolean(
      env,
      'LIVE_CANDLE_ALLOW_WITHOUT_RECONCILIATION',
      false,
    ),
  };

  if (config.ownerLeaseTtlMs <= config.ownerLeaseRenewMs) {
    throw new LiveCandleConfigError(
      'CANDLE_LIVE_OWNER_LEASE_TTL_MS must be greater than CANDLE_LIVE_OWNER_LEASE_RENEW_MS.',
    );
  }
  if (config.reconnectMinMs > config.reconnectMaxMs) {
    throw new LiveCandleConfigError(
      'CANDLE_LIVE_RECONNECT_MIN_MS must be less than or equal to CANDLE_LIVE_RECONNECT_MAX_MS.',
    );
  }
  if (config.kisUsDelayedEnabled && (!config.enabled || !config.kisEnabled)) {
    throw new LiveCandleConfigError(
      'CANDLE_LIVE_KIS_US_DELAYED_ENABLED requires live streaming and KIS live candles to be enabled.',
    );
  }

  return config;
}

/**
 * Live ingestion must not run without its reconciliation safety net: live
 * buckets that miss provider-final confirmation are only ever repaired by
 * REST reconciliation, so silently running one without the other loses data.
 *
 * Production refuses to start on an invalid combination unless the explicit
 * LIVE_CANDLE_ALLOW_WITHOUT_RECONCILIATION=true escape hatch is set;
 * non-production logs a warning through the returned list.
 */
export function validateLiveReconciliationDependencies(input: {
  live: LiveCandleConfig;
  reconciliation: {
    krx: { enabled: boolean };
    us: { enabled: boolean };
    crypto: { enabled: boolean };
  };
  nodeEnv: string | undefined;
}): string[] {
  if (!input.live.enabled) return [];
  const violations: string[] = [];
  if (input.live.kisEnabled && !input.reconciliation.krx.enabled) {
    violations.push(
      'CANDLE_LIVE_KIS_ENABLED=true requires CANDLE_RECONCILIATION_KRX_ENABLED=true.',
    );
  }
  if (input.live.kisUsDelayedEnabled && !input.reconciliation.us.enabled) {
    violations.push(
      'CANDLE_LIVE_KIS_US_DELAYED_ENABLED=true requires CANDLE_RECONCILIATION_US_ENABLED=true.',
    );
  }
  if (input.live.binanceEnabled && !input.reconciliation.crypto.enabled) {
    violations.push(
      'CANDLE_LIVE_BINANCE_ENABLED=true requires CANDLE_RECONCILIATION_CRYPTO_ENABLED=true.',
    );
  }
  if (
    violations.length > 0 &&
    input.nodeEnv === 'production' &&
    !input.live.allowWithoutReconciliation
  ) {
    throw new LiveCandleConfigError(
      `Live candle ingestion without reconciliation is not allowed in production: ${violations.join(' ')} Set LIVE_CANDLE_ALLOW_WITHOUT_RECONCILIATION=true only for exceptional, temporary operation.`,
    );
  }
  return violations;
}

function boolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new LiveCandleConfigError(`${name} must be true, false, 1, or 0.`);
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  if (!/^\d+$/u.test(text)) {
    throw new LiveCandleConfigError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new LiveCandleConfigError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}
