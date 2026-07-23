import { parseLimitOrderEnabled } from '../limit-order.config';
import {
  LimitOrderMatchingConfigError,
  readLimitOrderMatchingConfig,
} from './limit-order-matching.config';

export type LimitOrderCandleReconciliationConfig = {
  enabled: boolean;
  /**
   * CATCH-UP BOUND ONLY. How far back a single sweep may reach when it has no
   * durable position yet (bootstrap) and how large a warning-worthy catch-up
   * range is. It is NOT a correctness bound: an unprocessed candle older than
   * this is never dropped — it is carried by the durable checkpoint watermark
   * and the deferred queue, and its absence from retention is reported as a
   * gap rather than silently skipped.
   */
  lookbackMs: number;
  candleBatchSize: number;
  orderBatchSize: number;
  /**
   * How long a closed window must have been elapsed before the watermark may
   * advance past it. A canonical closed row is written by the finalizer some
   * time after the window ends; advancing the position over a window whose row
   * has not landed yet would skip it forever. Recent candles are still
   * PROCESSED immediately — only the position lags.
   */
  watermarkSafetyLagMs: number;
  /**
   * Two-phase guard on the STORAGE-order position: how much database time must
   * pass between observing a sequence value and being allowed to use it as a
   * watermark ceiling.
   *
   * A sequence value is assigned when a candle row is INSERTED but only becomes
   * visible when its transaction COMMITS, so the highest visible value can
   * still have uncommitted holes below it. This bounds how long a write
   * transaction on `market_candles` may stay open before the guard could be
   * wrong — and it is not the only bound: when the database role can read
   * other backends' `xact_start`, an in-flight write transaction older than the
   * observation holds the position back exactly, regardless of this value.
   */
  ingestSettleGraceMs: number;
  /**
   * Window COMPLETION protocol: how many 5m windows per asset one sweep may
   * evaluate for completeness. Bounds catch-up work per tick; nothing is
   * dropped by the bound — the cursor simply continues next tick.
   */
  completionWindowBatchSize: number;
  /**
   * How many REST-repair probes one sweep may spend certifying windows whose
   * candle row is missing (across all assets). A missing window past the
   * budget stays pending and is retried next tick.
   */
  completionRepairBudgetPerSweep: number;
  /**
   * Asset-scoped health gate: how long the FIRST unaccounted window of an
   * asset may stay pending before new quotes/creates on that asset fail
   * closed with LIMIT_ORDER_CANDLE_FINALIZER_STALE.
   */
  assetFinalizerStaleMs: number;
  /** Asset-scoped health gate: open deferred candles per asset that fail closed. */
  maxAssetDeferredBacklog: number;
  /** Deferred rows retried per sweep (bounded, oldest due first). */
  deferredRetryBatchSize: number;
  /** First retry delay; doubles per attempt up to deferredRetryMaxDelayMs. */
  deferredRetryBaseDelayMs: number;
  deferredRetryMaxDelayMs: number;
  /** Attempts before a deferred candle is parked as `permanent`. */
  deferredMaxAttempts: number;
  /**
   * Health gate: how long ago the sweep may last have completed a run before
   * NEW quotes/creates fail closed. This measures the RUNNER's liveness (the
   * 60s Ops tick), not the watermark's deliberate safety lag.
   */
  healthMaxAgeMs: number;
  /**
   * Health gate: how long ago the WINDOW-COMPLETION pass may last have
   * SUCCEEDED before new quotes/creates fail closed. Separate from
   * healthMaxAgeMs because the two heartbeats are separate: a completion pass
   * that keeps failing must not hide behind a healthy row-scan heartbeat.
   */
  completionHealthMaxAgeMs: number;
  /**
   * Health gate: EMERGENCY GLOBAL backlog threshold on the total deferred +
   * permanent queue size across ALL assets. Asset-scoped isolation is the
   * normal containment (maxAssetDeferredBacklog); this trips only when the
   * whole queue grows to a size that threatens system capacity, and it blocks
   * every asset. Keep it comfortably above maxAssetDeferredBacklog.
   */
  maxDeferredBacklog: number;
  /**
   * ASSET-scoped health gate: oldest open deferral age (for one asset) that
   * fails that asset closed. Deliberately not a global trigger — one asset's
   * stuck candle must not block every other asset's new orders.
   */
  maxDeferredAgeMs: number;
  /** Health gate: repeated reservation mismatches that fail closed. */
  maxReservationMismatchCount: number;
  /**
   * Retention horizon of the 5m candle table, in days. Read from the SAME
   * variable the retention job uses (MARKET_CANDLE_5M_RETENTION_DAYS) so the
   * two can never drift apart.
   *
   * Once the durable watermark is older than this, retention is PROVABLY
   * deleting windows the sweep has not examined, and that is a gap. The
   * comparison is deliberately against the retention POLICY rather than
   * against the oldest surviving row: "the oldest retained candle starts after
   * the watermark" is also true, harmlessly, whenever candle history simply
   * begins later than the watermark (a newly stored asset, a market with no
   * trades in the window), and turning that into a fail-closed alarm would
   * block every new limit order for an entirely healthy system.
   */
  candleRetentionDays: number;
};

export function readLimitOrderCandleReconciliationConfig(
  env: NodeJS.ProcessEnv = process.env,
): LimitOrderCandleReconciliationConfig {
  const enabled = parseLimitOrderEnabled(
    env.LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED,
    'LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED',
  );
  // Path B is a SAFETY NET under path A, never a replacement for it. Running
  // it alone would mean every fill happens minutes late at the limit price
  // even when exact trade evidence was available, so the combination is
  // rejected at startup instead of being silently downgraded.
  if (enabled && !readLimitOrderMatchingConfig(env).enabled) {
    throw new LimitOrderMatchingConfigError(
      'LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED requires LIMIT_ORDER_AUTO_EXECUTION_ENABLED=true.',
    );
  }
  const config: LimitOrderCandleReconciliationConfig = {
    enabled,
    lookbackMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_LOOKBACK_MS',
      3_600_000,
      300_000,
      86_400_000,
    ),
    candleBatchSize: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_CANDLE_BATCH_SIZE',
      200,
      1,
      5000,
    ),
    orderBatchSize: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_ORDER_BATCH_SIZE',
      100,
      1,
      1000,
    ),
    watermarkSafetyLagMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_WATERMARK_SAFETY_LAG_MS',
      900_000,
      300_000,
      86_400_000,
    ),
    ingestSettleGraceMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_INGEST_SETTLE_GRACE_MS',
      60_000,
      1000,
      3_600_000,
    ),
    completionWindowBatchSize: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_COMPLETION_WINDOW_BATCH_SIZE',
      24,
      1,
      1000,
    ),
    completionRepairBudgetPerSweep: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_COMPLETION_REPAIR_BUDGET_PER_SWEEP',
      5,
      0,
      100,
    ),
    assetFinalizerStaleMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_ASSET_FINALIZER_STALE_MS',
      1_800_000,
      60_000,
      86_400_000,
    ),
    maxAssetDeferredBacklog: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_MAX_ASSET_DEFERRED_BACKLOG',
      10,
      0,
      1_000_000,
    ),
    deferredRetryBatchSize: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_BATCH_SIZE',
      50,
      1,
      1000,
    ),
    deferredRetryBaseDelayMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_BASE_DELAY_MS',
      60_000,
      1000,
      3_600_000,
    ),
    deferredRetryMaxDelayMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_MAX_DELAY_MS',
      1_800_000,
      1000,
      86_400_000,
    ),
    deferredMaxAttempts: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_MAX_ATTEMPTS',
      50,
      1,
      10_000,
    ),
    healthMaxAgeMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_HEALTH_MAX_AGE_MS',
      300_000,
      60_000,
      86_400_000,
    ),
    completionHealthMaxAgeMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_COMPLETION_HEALTH_MAX_AGE_MS',
      300_000,
      60_000,
      86_400_000,
    ),
    maxDeferredBacklog: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_DEFERRED_BACKLOG',
      50,
      0,
      1_000_000,
    ),
    maxDeferredAgeMs: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_DEFERRED_AGE_MS',
      3_600_000,
      60_000,
      604_800_000,
    ),
    maxReservationMismatchCount: readInteger(
      env,
      'LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_RESERVATION_MISMATCH',
      1,
      0,
      1_000_000,
    ),
    // CONSUMED, not owned. `MARKET_CANDLE_5M_RETENTION_DAYS` belongs to the Ops
    // scheduler config, which is the single parser that validates it and
    // refuses to boot on a bad value. Re-validating it here would raise a
    // second, differently-typed error for the same variable and mask the
    // owner's message, so an unusable value simply falls back to the default —
    // startup fails on it either way, through its owner.
    candleRetentionDays: readOptionalPositiveInteger(
      env.MARKET_CANDLE_5M_RETENTION_DAYS,
      35,
    ),
  };

  if (config.deferredRetryMaxDelayMs < config.deferredRetryBaseDelayMs) {
    throw new LimitOrderMatchingConfigError(
      'LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_MAX_DELAY_MS must be greater than or equal to LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_BASE_DELAY_MS.',
    );
  }
  // The global threshold is the EMERGENCY tier above the per-asset gate. A
  // global bound at or below the asset bound would let a single asset's
  // contained backlog trip the whole-system gate, defeating asset isolation.
  if (config.maxDeferredBacklog < config.maxAssetDeferredBacklog) {
    throw new LimitOrderMatchingConfigError(
      'LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_DEFERRED_BACKLOG must be greater than or equal to LIMIT_ORDER_CANDLE_MAX_ASSET_DEFERRED_BACKLOG.',
    );
  }
  // The bootstrap reach must cover at least the window the watermark
  // deliberately holds back, otherwise a first run could never catch up to its
  // own safety lag.
  if (config.lookbackMs < config.watermarkSafetyLagMs) {
    throw new LimitOrderMatchingConfigError(
      'LIMIT_ORDER_CANDLE_RECONCILIATION_LOOKBACK_MS must be greater than or equal to LIMIT_ORDER_CANDLE_RECONCILIATION_WATERMARK_SAFETY_LAG_MS.',
    );
  }

  return config;
}

/** Lenient read for a variable another module owns and strictly validates. */
function readOptionalPositiveInteger(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
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
