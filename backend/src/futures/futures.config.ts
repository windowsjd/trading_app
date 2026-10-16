import { HttpStatus } from '@nestjs/common';
import { parseLimitOrderEnabled } from '../orders/limit-order.config';
import { futuresError } from './futures-error';

export function futuresTradingMode(env: NodeJS.ProcessEnv = process.env) {
  const legacy = parseLimitOrderEnabled(
    env.FUTURES_TRADING_ENABLED,
    'FUTURES_TRADING_ENABLED',
  );
  const mode = env.FUTURES_TRADING_MODE?.trim().toUpperCase();
  if (mode === undefined || mode === '') return legacy ? 'ENABLED' : 'DISABLED';
  if (mode !== 'ENABLED' && mode !== 'REDUCE_ONLY' && mode !== 'DISABLED')
    throw new Error(
      'FUTURES_TRADING_MODE must be ENABLED, REDUCE_ONLY or DISABLED',
    );
  return mode;
}
export function isFuturesTradingEnabled(env: NodeJS.ProcessEnv = process.env) {
  return futuresTradingMode(env) === 'ENABLED';
}
export function futuresRiskConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = parseLimitOrderEnabled(
    env.FUTURES_RISK_ENGINE_ENABLED,
    'FUTURES_RISK_ENGINE_ENABLED',
  );
  const ingestion = parseLimitOrderEnabled(
    env.FUTURES_MARK_INGESTION_ENABLED,
    'FUTURES_MARK_INGESTION_ENABLED',
  );
  return {
    enabled,
    ingestion,
    intervalMs: 1000,
    batchSize: 250,
    concurrency: 8,
  };
}
/** Futures Last ingestion follows Mark ingestion unless set explicitly. */
export function futuresLastPriceConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    ingestion: parseLimitOrderEnabled(
      env.FUTURES_LAST_PRICE_INGESTION_ENABLED ??
        env.FUTURES_MARK_INGESTION_ENABLED,
      'FUTURES_LAST_PRICE_INGESTION_ENABLED',
    ),
  };
}
/** Display-only order book and 24h statistics streams (no REST, no finance
 * authority). They follow Futures Last ingestion unless set explicitly. */
export function futuresMarketDataConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    streaming: parseLimitOrderEnabled(
      env.FUTURES_MARKET_DATA_STREAMING_ENABLED ??
        env.FUTURES_LAST_PRICE_INGESTION_ENABLED ??
        env.FUTURES_MARK_INGESTION_ENABLED,
      'FUTURES_MARKET_DATA_STREAMING_ENABLED',
    ),
  };
}
/** Futures Conditional Entry v1 (new watches and triggers only; read, cancel
 * and lifecycle cleanup stay available). Strict true/false; omitted is false. */
export function futuresConditionalEntryEnabled(
  env: NodeJS.ProcessEnv = process.env,
) {
  const value = env.FUTURES_CONDITIONAL_ENTRY_ENABLED ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error('FUTURES_CONDITIONAL_ENTRY_ENABLED must be true or false');
  return value === 'true';
}
/** Independent Futures stop-loss / take-profit settings and Futures entry
 * plans (new registrations and triggers only; read, cancel, lifecycle cleanup
 * and an entry plan's activation at its entry's fill stay available).
 * Strict true/false; omitted is false. */
export function futuresTpSlEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.FUTURES_TP_SL_ORDERS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error('FUTURES_TP_SL_ORDERS_ENABLED must be true or false');
  return value === 'true';
}
export function validateFuturesConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = futuresTradingMode(env);
  const risk = futuresRiskConfig(env);
  const last = futuresLastPriceConfig(env);
  futuresMarketDataConfig(env);
  futuresConditionalEntryEnabled(env);
  futuresTpSlEnabled(env);
  if (mode === 'ENABLED' && (!risk.enabled || !risk.ingestion))
    throw new Error(
      'FUTURES_TRADING_MODE ENABLED requires FUTURES_RISK_ENGINE_ENABLED and FUTURES_MARK_INGESTION_ENABLED',
    );
  // Every user execution and conditional exit is priced from Futures Last.
  if (mode !== 'DISABLED' && !last.ingestion)
    // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
    throw new Error(
      'FUTURES_TRADING_MODE ENABLED or REDUCE_ONLY requires FUTURES_LAST_PRICE_INGESTION_ENABLED',
    );
}
export function assertFuturesOperation(operation: string) {
  const mode = futuresTradingMode();
  if (mode === 'DISABLED')
    futuresError(
      'FUTURES_TRADING_DISABLED',
      'Futures trading is disabled.',
      HttpStatus.FORBIDDEN,
    );
  if (mode === 'REDUCE_ONLY' && ['open', 'increase'].includes(operation))
    futuresError(
      'FUTURES_REDUCE_ONLY',
      'Only risk-reducing Futures trades are enabled.',
      HttpStatus.FORBIDDEN,
    );
}
