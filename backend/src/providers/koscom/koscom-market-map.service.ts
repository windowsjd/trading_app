import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { KoscomClient, koscomRecord } from './koscom.client';
import {
  KOSCOM_MARKETS,
  KoscomConfigService,
  KoscomError,
  koscomFailure,
  type KoscomMarket,
} from './koscom.config';

// 2c (F15): a failing list waits 30 s, 60 s, … up to 30 min between fetches
// across the cluster instead of every 30 s per process.
const LIST_BACKOFF_BASE_MS = 30_000;
const LIST_BACKOFF_MAX_MS = 30 * 60_000;
const LIST_FETCH_LEASE_MS = 30_000;

@Injectable()
export class KoscomMarketMapService {
  private pending: Promise<Map<string, KoscomMarket>> | null = null;
  private cached: { expires: number; map: Map<string, KoscomMarket> } | null =
    null;
  private failedLoad: {
    expires: number;
    namespace: string;
    code: string;
  } | null = null;
  constructor(
    private readonly client: KoscomClient,
    private readonly redis: RedisService,
    private readonly config: KoscomConfigService,
  ) {}

  async resolve(
    symbol: string,
    assetMarket: string,
    signal?: AbortSignal,
  ): Promise<KoscomMarket> {
    if (signal?.aborted)
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_CANCELED',
      );
    if (!/^\d{6}$/.test(symbol))
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_INVALID_SYMBOL',
      );
    const explicit = assetMarket.toLowerCase() as KoscomMarket;
    if (
      !KOSCOM_MARKETS.includes(explicit) &&
      explicit !== ('krx' as KoscomMarket)
    )
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_MARKET_UNSUPPORTED',
      );
    const map = await waitForMap(this.load(), signal);
    const market = map.get(symbol);
    if (!market)
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_MARKET_UNRESOLVED',
      );
    if (explicit !== ('krx' as KoscomMarket) && explicit !== market)
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_MARKET_MISMATCH',
      );
    return market;
  }

  private load(): Promise<Map<string, KoscomMarket>> {
    const config = this.config.getConfig();
    if (!config.enabled)
      return Promise.reject(
        /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_DISABLED',
        ),
      );
    if (
      this.failedLoad?.namespace === config.namespace &&
      Date.now() < this.failedLoad.expires
    )
      return Promise.reject(
        /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          this.failedLoad.code,
        ),
      );
    if (this.cached && Date.now() < this.cached.expires)
      return Promise.resolve(this.cached.map);
    this.pending ??= this.fetch()
      .catch((error) => {
        // A failed full list must not be requested again for every asset in the
        // same collection cycle. A new API-key namespace can retry immediately.
        const code = koscomFailure(error);
        this.failedLoad = {
          expires: Date.now() + 30000,
          namespace: config.namespace,
          code,
        };
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          code,
        );
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async fetch() {
    if (!this.config.getConfig().enabled)
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_DISABLED',
      );
    const map = new Map<string, KoscomMarket>();
    const ambiguous = new Set<string>();
    // Only positive official membership is usable. A failed market must not
    // disable symbols proven by another market's successful list.
    const results = await Promise.allSettled(
      KOSCOM_MARKETS.map(async (market) => {
        const key = `koscom:${this.config.getConfig().namespace}:symbols:${market}`;
        const cached = await this.redis.get(key).catch(() => null);
        if (cached) {
          try {
            const parsed: unknown = JSON.parse(cached);
            if (
              Array.isArray(parsed) &&
              parsed.length &&
              parsed.every((v) => typeof v === 'string' && /^\d{6}$/.test(v))
            )
              return { market, symbols: parsed as string[] };
          } catch {
            /* refresh invalid cache */
          }
        }
        const symbols = await this.fetchList(market);
        await this.redis
          .setWithTtl(key, JSON.stringify(symbols), 21600)
          .catch(() => undefined);
        return { market, symbols };
      }),
    );
    const lists = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (!lists.length) {
      const failure = results.find((result) => result.status === 'rejected');
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        failure?.status === 'rejected'
          ? koscomFailure(failure.reason)
          : 'KOSCOM_EMPTY_LIST',
      );
    }
    for (const { market, symbols } of lists)
      for (const symbol of symbols) {
        if (map.has(symbol) && map.get(symbol) !== market)
          ambiguous.add(symbol);
        map.set(symbol, market);
      }
    for (const symbol of ambiguous) map.delete(symbol);
    this.cached = {
      expires:
        Date.now() + (lists.length === KOSCOM_MARKETS.length ? 300000 : 30000),
      map,
    };
    return map;
  }

  private async fetchList(market: KoscomMarket): Promise<string[]> {
    const config = this.config.getConfig();
    const prefix = `koscom:${config.namespace}:lists`;
    if (config.listBackoffEnabled) {
      const until = await this.redis
        .get(`${prefix}:backoff-until:${market}`)
        .catch(() => null);
      if (until !== null && Number(until) > Date.now())
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_LIST_BACKOFF',
        );
      // Cluster single flight: whoever fetches fills the shared 6 h cache.
      const leader = await this.redis
        .setNxPx(`${prefix}:fetching:${market}`, '1', LIST_FETCH_LEASE_MS)
        .catch(() => true);
      if (!leader)
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_LIST_FETCH_IN_PROGRESS',
        );
    }
    try {
      // Always P1 `lists`, whichever caller's category context resolved it.
      const { result } = await this.client.get(
        `/v3/market/closed/${market}/lists`,
        {},
        undefined,
        { category: 'lists' },
      );
      if (!Array.isArray(result.isuLists))
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_MALFORMED_LIST',
        );
      const symbols = result.isuLists
        .map((value) => koscomRecord(value).isuSrtCd)
        .filter((v): v is string => typeof v === 'string' && /^\d{6}$/.test(v));
      if (!symbols.length)
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_EMPTY_LIST',
        );
      if (config.listBackoffEnabled)
        await this.redis
          .delete(`${prefix}:failures:${market}`)
          .catch(() => undefined);
      return symbols;
    } catch (error) {
      if (config.listBackoffEnabled) await this.backOffList(prefix, market);
      throw error;
    } finally {
      if (config.listBackoffEnabled)
        await this.redis
          .delete(`${prefix}:fetching:${market}`)
          .catch(() => undefined);
    }
  }

  private async backOffList(prefix: string, market: KoscomMarket) {
    try {
      const failures = await this.redis.increment(
        `${prefix}:failures:${market}`,
      );
      await this.redis.expire(`${prefix}:failures:${market}`, 86_400);
      const backoffMs = Math.min(
        LIST_BACKOFF_MAX_MS,
        LIST_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
      );
      await this.redis.setWithTtl(
        `${prefix}:backoff-until:${market}`,
        String(Date.now() + backoffMs),
        Math.ceil(backoffMs / 1000),
      );
    } catch {
      // Without Redis the per-process 30 s back-off below still applies.
    }
  }
}

// A timed-out chart may stop waiting without canceling the shared master load.
function waitForMap<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(
      /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_CANCELED',
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_CANCELED',
        ),
      );
    signal.addEventListener('abort', abort, { once: true });
    void pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
