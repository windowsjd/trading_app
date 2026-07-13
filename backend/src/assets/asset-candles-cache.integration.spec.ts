import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { readRedisConfig } from '../redis/redis.config';
import type { AssetCandlesResponse } from './asset-candles.service';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import {
  buildCandleDataKey,
  buildCandleGenerationKey,
  CandleCacheKeyInput,
} from './asset-candles-cache.keys';

// Opt-in real Redis smoke. Runs only with CANDLE_CACHE_REDIS_SMOKE=1 and a
// reachable REDIS_URL; otherwise Jest reports it as skipped (never a silent
// no-op pass). In-process, so it runs identically on Windows and Linux/WSL. It
// needs no DB migration and makes no provider calls. It only ever touches keys
// under a random-UUID asset namespace and deletes exactly those keys; it never
// runs FLUSHDB/FLUSHALL or namespace-wide KEYS/SCAN deletes.
const RUN_REDIS_SMOKE = process.env.CANDLE_CACHE_REDIS_SMOKE === '1';
const itRedis = RUN_REDIS_SMOKE ? it : it.skip;

const buildResponse = (): AssetCandlesResponse => ({
  success: true,
  data: {
    state: 'available',
    asset: {
      id: 'smoke-asset',
      symbol: 'BTCUSDT',
      name: 'Bitcoin',
      assetType: 'crypto',
      market: 'BINANCE',
      priceCurrency: 'USD',
    },
    range: '1d',
    interval: '5m',
    requestedDate: '2026-07-10',
    candles: [
      {
        time: '2026-07-10T00:00:00.000Z',
        open: '100.00000000',
        high: '110.00000000',
        low: '95.00000000',
        close: '105.00000000',
        volume: '10.00000000',
        amount: '1000.00000000',
        sourceDate: '20260710',
        sourceTime: '000000',
      },
    ],
    source: {
      provider: 'binance',
      endpoint: '/api/v3/klines',
      symbol: 'BTCUSDT',
      interval: '5m',
      requestedCount: 100,
      returnedCount: 1,
    },
  },
});

describe('AssetCandlesCacheService Redis smoke', () => {
  itRedis(
    'verifies ping, set/get, TTL, exact delete, generation invalidation, and corrupt handling against real Redis',
    async () => {
      const redis = new RedisService(readRedisConfig());
      const cache = new AssetCandlesCacheService(redis, {
        enabled: true,
        maxPayloadBytes: 2 * 1024 * 1024,
      });

      const assetId = `candle-cache-smoke-${randomUUID()}`;
      const input: CandleCacheKeyInput = {
        assetId,
        range: '1d',
        interval: '5m',
        limit: 100,
        requestedDate: '2026-07-10',
      };
      const generationKey = buildCandleGenerationKey(assetId);
      const dataKeyGen0 = buildCandleDataKey({ ...input, generation: 0 });
      const dataKeyGen1 = buildCandleDataKey({ ...input, generation: 1 });

      try {
        expect(await redis.ping()).toBe('PONG');

        const response = buildResponse();
        const stored = await cache.set(input, response);
        expect(stored.status).toBe('stored');

        const hit = await cache.get(input);
        expect(hit.status).toBe('fresh');
        if (hit.status === 'fresh') {
          expect(hit.value).toEqual(response);
          expect(hit.cachedAt).toBeInstanceOf(Date);
        }

        // Redis retains the envelope through its stale TTL (current-data
        // entries default to CANDLE_CACHE_CURRENT_STALE_TTL_SECONDS or the
        // historical stale TTL, both bounded by an hour).
        const ttl = await redis.ttl(dataKeyGen0);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(3600);

        const deleted = await cache.delete(input);
        expect(deleted.status).toBe('invalidated');
        expect((await cache.get(input)).status).toBe('miss');

        // Re-store, then invalidate the asset: the old generation-0 entry
        // survives in Redis but is no longer reachable through the cache.
        await cache.set(input, response);
        expect((await cache.get(input)).status).toBe('fresh');

        const invalidated = await cache.invalidateAsset(assetId);
        expect(invalidated.status).toBe('invalidated');
        if (invalidated.status === 'invalidated') {
          expect(invalidated.generation).toBe(1);
        }
        expect((await cache.get(input)).status).toBe('miss');

        // Corrupt entry at the current generation: the read reports it as
        // corrupt and deletes exactly that key; the next read is a miss.
        await redis.setWithTtl(dataKeyGen1, 'not-json{', 30);
        expect((await cache.get(input)).status).toBe('corrupt');
        expect(await redis.get(dataKeyGen1)).toBeNull();
        expect((await cache.get(input)).status).toBe('miss');
      } finally {
        // Delete only the keys this test created.
        await redis.delete(generationKey);
        await redis.delete(dataKeyGen0);
        await redis.delete(dataKeyGen1);
        await redis.onModuleDestroy();
      }
    },
    30_000,
  );
});
