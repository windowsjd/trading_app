export const LIVE_CANDLE_CONFIG = Symbol('LIVE_CANDLE_CONFIG');

/**
 * Binance's documented hard limit: a single raw WebSocket connection accepts at
 * most 1024 streams. Exceeding it does not degrade gracefully — the SUBSCRIBE
 * is rejected and the connection carries no market data at all.
 */
export const BINANCE_MAX_STREAMS_PER_CONNECTION = 1_024;

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
  // Connection liveness: how long a provider socket may go without ANY frame
  // (trade, ack, PINGPONG, WS ping) before the supervisor closes it. Used by
  // the reconnect watchdog only — never by readiness.
  connectionLivenessTimeoutMs: number;
  // Trade freshness: how old the last processed trade/kline event may be
  // before readiness reports LIVE_PROVIDER_STALE (only while the market can
  // trade; delayed feeds are excluded). Used by readiness only — never by
  // the reconnect watchdog.
  tradeStaleThresholdMs: number;
  maxSubscriptionsPerClient: number;
  /**
   * Cap on ASSETS subscribed on one provider connection. Kept for backward
   * compatibility and still enforced, but it is NOT the provider's real limit:
   * Binance counts STREAMS, and an asset costs two of them once exact-trade
   * matching rides the same socket.
   */
  maxProviderSubscriptionsPerShard: number;
  /**
   * Cap on raw provider STREAMS on one connection — the unit Binance actually
   * limits (1024 per connection). With the matcher off an asset costs one
   * stream (`<symbol>@kline_5m`); with it on it costs two
   * (`<symbol>@kline_5m` + `<symbol>@trade`), so an asset-count cap of 1024
   * would silently request 2048 streams and have the whole SUBSCRIBE rejected.
   */
  maxProviderStreamsPerShard: number;
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
    // CANDLE_LIVE_STALE_THRESHOLD_MS is DEPRECATED: it conflated connection
    // liveness with trade freshness. It remains only as the fallback when
    // the dedicated variable is unset; the new variables always win.
    connectionLivenessTimeoutMs: integerWithDeprecatedFallback(
      env,
      'CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS',
      'CANDLE_LIVE_STALE_THRESHOLD_MS',
      90_000,
      5_000,
      3_600_000,
    ),
    tradeStaleThresholdMs: integerWithDeprecatedFallback(
      env,
      'CANDLE_LIVE_TRADE_STALE_THRESHOLD_MS',
      'CANDLE_LIVE_STALE_THRESHOLD_MS',
      30_000,
      1_000,
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
    maxProviderStreamsPerShard: integer(
      env,
      'CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD',
      BINANCE_MAX_STREAMS_PER_CONNECTION,
      1,
      BINANCE_MAX_STREAMS_PER_CONNECTION,
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
    recoveryMaxBatch: integer(
      env,
      'CANDLE_LIVE_RECOVERY_MAX_BATCH',
      10,
      1,
      200,
    ),
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
  // A liveness timeout below the trade-stale threshold would reconnect a
  // healthy socket before its market data is even considered stale. Equal
  // values are allowed (the deprecated single variable sets both).
  if (config.connectionLivenessTimeoutMs < config.tradeStaleThresholdMs) {
    throw new LiveCandleConfigError(
      'CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS must be greater than or equal to CANDLE_LIVE_TRADE_STALE_THRESHOLD_MS.',
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

/**
 * Reads `name`, falling back to the deprecated `deprecatedName` only when
 * `name` is unset. An invalid value in EITHER variable is a configuration
 * error — a bad deprecated value is never silently replaced by the default.
 */
function integerWithDeprecatedFallback(
  env: NodeJS.ProcessEnv,
  name: string,
  deprecatedName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (env[name]?.trim()) return integer(env, name, fallback, min, max);
  if (env[deprecatedName]?.trim()) {
    try {
      return integer(env, deprecatedName, fallback, min, max);
    } catch {
      throw new LiveCandleConfigError(
        `${deprecatedName} (deprecated fallback for ${name}) must be an integer between ${min} and ${max}; prefer setting ${name} directly.`,
      );
    }
  }
  return fallback;
}
