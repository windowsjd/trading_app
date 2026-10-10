import { parseLimitOrderEnabled } from '../orders/limit-order.config';

export function futuresLastPriceRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
) {
  const integer = (name: string, fallback: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
      throw new Error(`${name} must be an integer from 1 to ${max}`);
    return value;
  };
  return {
    // Follows Futures Last ingestion, which itself follows Mark ingestion.
    enabled: parseLimitOrderEnabled(
      env.FUTURES_LAST_PRICE_RETENTION_ENABLED ??
        env.FUTURES_LAST_PRICE_INGESTION_ENABLED ??
        env.FUTURES_MARK_INGESTION_ENABLED,
      'FUTURES_LAST_PRICE_RETENTION_ENABLED',
    ),
    hours: integer('FUTURES_LAST_PRICE_RETENTION_HOURS', 24, 8760),
    batchSize: integer('FUTURES_LAST_PRICE_RETENTION_BATCH_SIZE', 1000, 10000),
    maxBatches: 10,
    intervalMs: 60000,
  };
}
