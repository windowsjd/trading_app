import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const KOSCOM_PRICE_SOURCE = 'koscom_krx_realtime_price';
export const KOSCOM_BOOK_SOURCE = 'koscom_krx_orderbook';
export const KOSCOM_MINUTE_SOURCE = 'koscom_intraday';
export const KOSCOM_HISTORY_SOURCE = 'koscom_history';
export const KOSCOM_MARKETS = ['kospi', 'kosdaq', 'konex'] as const;
export type KoscomMarket = (typeof KOSCOM_MARKETS)[number];

export function readKoscomConfig(env = process.env) {
  const apiKey = env.KOSCOM_API_KEY?.trim() ?? '';
  const baseUrl = env.KOSCOM_BASE_URL?.trim() || 'https://oap.k-mydata.org';
  const validOrigin = [
    'https://oap.k-mydata.org',
    'https://testoap.k-mydata.org',
  ].includes(baseUrl);
  return {
    apiKey,
    baseUrl,
    enabled:
      Boolean(apiKey) &&
      validOrigin &&
      !['false', '0'].includes(env.KOSCOM_MARKET_DATA_ENABLED?.trim() ?? '') &&
      ['true', '1'].includes(env.PROVIDER_INGESTION_ENABLED?.trim() ?? ''),
    pollingEnabled: ['true', '1'].includes(
      env.KOSCOM_POLLING_ENABLED?.trim() ?? '',
    ),
    pollIntervalMs: integer(env.KOSCOM_POLL_INTERVAL_MS, 3000, 1000, 60000),
    timeoutMs: integer(env.KOSCOM_HTTP_TIMEOUT_MS, 5000, 100, 15000),
    concurrency: integer(env.KOSCOM_MAX_CONCURRENCY, 2, 1, 4),
    minIntervalMs: integer(env.KOSCOM_MIN_REQUEST_INTERVAL_MS, 200, 50, 10000),
    namespace: createHash('sha256')
      .update(`${baseUrl}:${apiKey}`)
      .digest('hex')
      .slice(0, 16),
  };
}

function integer(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

@Injectable()
export class KoscomConfigService {
  getConfig() {
    return readKoscomConfig();
  }
}

/** Fixed categories only: never wrap provider/transport exception messages. */
export class KoscomError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'KoscomError';
  }
}

export function koscomFailure(error: unknown): string {
  return error instanceof KoscomError ? error.code : 'KOSCOM_OPERATION_FAILED';
}
