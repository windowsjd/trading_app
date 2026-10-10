import { Injectable } from '@nestjs/common';
import {
  RedisLockService,
  type RedisLock,
} from '../../redis/redis-lock.service';
import { RedisService } from '../../redis/redis.service';
import {
  KoscomConfigService,
  KoscomError,
  type KoscomMarket,
} from './koscom.config';

export type KoscomResponse = {
  result: Record<string, unknown>;
  receivedAt: Date;
};
export type KoscomTarget = {
  assetId: string;
  symbol: string;
  market: KoscomMarket;
};
export type KoscomBatch = { market: KoscomMarket; targets: KoscomTarget[] };

export function koscomBatches(targets: readonly KoscomTarget[]): KoscomBatch[] {
  const grouped = new Map<KoscomMarket, Map<string, KoscomTarget>>();
  for (const target of targets) {
    if (!/^\d{6}$/.test(target.symbol))
      throw new KoscomError('KOSCOM_INVALID_SYMBOL');
    const group = grouped.get(target.market) ?? new Map<string, KoscomTarget>();
    group.set(target.symbol, target);
    grouped.set(target.market, group);
  }
  return [...grouped].flatMap(([market, group]) => {
    const rows = [...group.values()];
    const size = market === 'konex' ? 1 : 20;
    return Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => ({
      market,
      targets: rows.slice(i * size, (i + 1) * size),
    }));
  });
}

/** Preserve every JSON number token before Number rounding (Node >=22). */
export function parseKoscomJson(text: string): unknown {
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      if (!context?.source)
        throw new KoscomError('KOSCOM_LOSSLESS_JSON_UNAVAILABLE');
      return context.source;
    },
  ) as unknown;
}

export function koscomRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new KoscomError('KOSCOM_MALFORMED_RESPONSE');
  return value as Record<string, unknown>;
}

@Injectable()
export class KoscomClient {
  private activeRequests = 0;
  private readonly pending = new Map<string, Promise<KoscomResponse>>();

  constructor(
    private readonly config: KoscomConfigService,
    private readonly redis: RedisService,
    private readonly locks: RedisLockService,
  ) {}

  get(
    path: string,
    query: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<KoscomResponse> {
    if (!this.config.getConfig().enabled)
      return Promise.reject(new KoscomError('KOSCOM_DISABLED'));
    if (
      !/^\/v3\/market\/(realtime|closed)\/(kospi|kosdaq|konex)\/[a-zA-Z0-9/]+$/.test(
        path,
      ) ||
      'apikey' in query
    )
      return Promise.reject(new KoscomError('KOSCOM_INVALID_REQUEST'));
    const identity = `${path}?${new URLSearchParams(query)}`;
    // Cancellation-bound candle jobs must not inherit another caller's signal.
    const shared = !signal && this.pending.get(identity);
    if (shared) return shared;
    if (this.activeRequests >= 64)
      return Promise.reject(new KoscomError('KOSCOM_QUEUE_FULL'));
    this.activeRequests++;
    const promise = this.request(path, query, signal).finally(() => {
      this.activeRequests--;
    });
    if (signal) return promise;
    this.pending.set(identity, promise);
    void promise
      .finally(() => this.pending.delete(identity))
      .catch(() => undefined);
    return promise;
  }

  async batch(
    batch: KoscomBatch,
    kind: 'price' | 'orderbook',
    signal?: AbortSignal,
  ) {
    if (
      !batch.targets.length ||
      batch.targets.length > 20 ||
      batch.targets.some((t) => t.market !== batch.market) ||
      (batch.market === 'konex' && batch.targets.length !== 1)
    )
      throw new KoscomError('KOSCOM_INVALID_BATCH');
    const single = batch.market === 'konex';
    const path = single
      ? `/v3/market/realtime/${batch.market}/stocks/${batch.targets[0].symbol}/${kind}`
      : `/v3/market/realtime/${batch.market}/multiquote/stocks/${kind}`;
    const response = await this.get(
      path,
      single ? {} : { isuCd: batch.targets.map((t) => t.symbol).join(',') },
      signal,
    );
    const rows = single ? [response.result] : response.result.isulist;
    if (!Array.isArray(rows) || rows.length > batch.targets.length)
      throw new KoscomError('KOSCOM_MALFORMED_RESPONSE');
    return { rows: rows.map(koscomRecord), receivedAt: response.receivedAt };
  }

  private async request(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<KoscomResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(path, query, signal);
      } catch (error) {
        const safe =
          error instanceof KoscomError
            ? error
            : new KoscomError('KOSCOM_REQUEST_FAILED');
        if (!safe.retryable || attempt >= 1 || signal?.aborted) throw safe;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  private async attempt(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<KoscomResponse> {
    const config = this.config.getConfig();
    if (!config.enabled) throw new KoscomError('KOSCOM_DISABLED');
    const lock = await this.admit(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, config.timeoutMs);
    try {
      if (signal?.aborted) throw new KoscomError('KOSCOM_CANCELED');
      const url = new URL(path, config.baseUrl);
      for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, value);
      url.searchParams.set('apikey', config.apiKey);
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const status = response.status;
        if (status === 401 || status === 403)
          throw new KoscomError('KOSCOM_AUTH_FAILED');
        if (status === 429) {
          await this.redis.setNxPx(
            `koscom:${config.namespace}:cooldown`,
            '1',
            10000,
          );
          throw new KoscomError('KOSCOM_RATE_LIMITED');
        }
        throw new KoscomError('KOSCOM_HTTP_FAILED', status >= 500);
      }
      const body = await response.text();
      const receivedAt = new Date();
      if (body.length > 8_000_000)
        throw new KoscomError('KOSCOM_RESPONSE_TOO_LARGE');
      let parsed: Record<string, unknown>;
      try {
        parsed = koscomRecord(parseKoscomJson(body));
      } catch {
        throw new KoscomError('KOSCOM_MALFORMED_RESPONSE');
      }
      if (parsed.error != null) throw new KoscomError('KOSCOM_API_ERROR');
      // Lists use a top-level isuLists; other v3 endpoints use JSON-RPC result.
      if (Array.isArray(parsed.isuLists) && path.endsWith('/lists'))
        return { result: parsed, receivedAt };
      if (parsed.jsonrpc !== '2.0')
        throw new KoscomError('KOSCOM_MALFORMED_RESPONSE');
      return { result: koscomRecord(parsed.result), receivedAt };
    } catch (error) {
      if (signal?.aborted) throw new KoscomError('KOSCOM_CANCELED');
      if (error instanceof KoscomError) throw error;
      throw new KoscomError(
        controller.signal.aborted ? 'KOSCOM_TIMEOUT' : 'KOSCOM_REQUEST_FAILED',
        true,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await this.locks.release(lock).catch(() => false);
    }
  }

  private async admit(signal?: AbortSignal): Promise<RedisLock> {
    const config = this.config.getConfig();
    const prefix = `koscom:${config.namespace}`;
    const deadline = performance.now() + 30000;
    try {
      while (performance.now() < deadline) {
        if (signal?.aborted) throw new KoscomError('KOSCOM_CANCELED');
        if (await this.redis.get(`${prefix}:cooldown`))
          throw new KoscomError('KOSCOM_RATE_LIMITED');
        for (let i = 0; i < config.concurrency; i++) {
          const acquired = await this.locks.acquire(
            `${prefix}:http:${i}`,
            config.timeoutMs + 5000,
          );
          if (acquired.status === 'error')
            throw new KoscomError('KOSCOM_COORDINATION_UNAVAILABLE');
          if (acquired.status !== 'acquired') continue;
          try {
            if (
              await this.redis.setNxPx(
                `${prefix}:request-spacing`,
                '1',
                config.minIntervalMs,
              )
            )
              return acquired.lock;
          } catch {
            await this.locks.release(acquired.lock);
            throw new KoscomError('KOSCOM_COORDINATION_UNAVAILABLE');
          }
          await this.locks.release(acquired.lock);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new KoscomError('KOSCOM_QUEUE_TIMEOUT');
    } catch (error) {
      if (error instanceof KoscomError) throw error;
      throw new KoscomError('KOSCOM_COORDINATION_UNAVAILABLE');
    }
  }
}
