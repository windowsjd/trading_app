import { parseLimitOrderEnabled } from '../limit-order.config';
import {
  LimitOrderMatchingConfigError,
  readLimitOrderMatchingConfig,
} from './limit-order-matching.config';

export type LimitOrderCandleReconciliationConfig = {
  enabled: boolean;
  /** How far back a sweep may look for still-unprocessed closed candles. */
  lookbackMs: number;
  candleBatchSize: number;
  orderBatchSize: number;
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
  return {
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
  };
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
