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
    if (signal?.aborted) throw new KoscomError('KOSCOM_CANCELED');
    if (!/^\d{6}$/.test(symbol)) throw new KoscomError('KOSCOM_INVALID_SYMBOL');
    const explicit = assetMarket.toLowerCase() as KoscomMarket;
    if (
      !KOSCOM_MARKETS.includes(explicit) &&
      explicit !== ('krx' as KoscomMarket)
    )
      throw new KoscomError('KOSCOM_MARKET_UNSUPPORTED');
    const map = await waitForMap(this.load(), signal);
    const market = map.get(symbol);
    if (!market) throw new KoscomError('KOSCOM_MARKET_UNRESOLVED');
    if (explicit !== ('krx' as KoscomMarket) && explicit !== market)
      throw new KoscomError('KOSCOM_MARKET_MISMATCH');
    return market;
  }

  private load(): Promise<Map<string, KoscomMarket>> {
    const config = this.config.getConfig();
    if (!config.enabled)
      return Promise.reject(new KoscomError('KOSCOM_DISABLED'));
    if (
      this.failedLoad?.namespace === config.namespace &&
      Date.now() < this.failedLoad.expires
    )
      return Promise.reject(new KoscomError(this.failedLoad.code));
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
        throw new KoscomError(code);
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async fetch() {
    if (!this.config.getConfig().enabled)
      throw new KoscomError('KOSCOM_DISABLED');
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
        const { result } = await this.client.get(
          `/v3/market/closed/${market}/lists`,
        );
        if (!Array.isArray(result.isuLists))
          throw new KoscomError('KOSCOM_MALFORMED_LIST');
        const symbols = result.isuLists
          .map((value) => koscomRecord(value).isuSrtCd)
          .filter(
            (v): v is string => typeof v === 'string' && /^\d{6}$/.test(v),
          );
        if (!symbols.length) throw new KoscomError('KOSCOM_EMPTY_LIST');
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
      throw new KoscomError(
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
}

// A timed-out chart may stop waiting without canceling the shared master load.
function waitForMap<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(new KoscomError('KOSCOM_CANCELED'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new KoscomError('KOSCOM_CANCELED'));
    signal.addEventListener('abort', abort, { once: true });
    void pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
