import { randomUUID } from 'node:crypto';
import { RedisLockService } from '../../../redis/redis-lock.service';
import { readRedisConfig } from '../../../redis/redis.config';
import { RedisService } from '../../../redis/redis.service';
import { readKisRateLimitConfig } from './kis-rate-limit.config';
import { KisRateLimiterService } from './kis-rate-limiter.service';
import { AssetCandlesCacheService } from '../../../assets/asset-candles-cache.service';
import type { AssetCandlesResponse } from '../../../assets/asset-candles.service';
import {
  buildCandleDataKey,
  buildCandleGenerationKey,
} from '../../../assets/asset-candles-cache.keys';
import { RedisUnavailableError } from '../../../redis/redis.types';

const describeRedis =
  process.env.KIS_COORDINATION_REDIS_SMOKE === '1' ? describe : describe.skip;

describeRedis('KIS coordination real Redis smoke', () => {
  jest.setTimeout(15_000);

  it('shares atomic rate slots and token-owned locks without global cleanup', async () => {
    const redis = new RedisService(readRedisConfig());
    const namespace = randomUUID();
    const config = readKisRateLimitConfig({
      KIS_APP_KEY: namespace,
      KIS_API_ENVIRONMENT: 'real',
      KIS_REST_MIN_INTERVAL_MS: '125',
      KIS_OAUTH_MIN_INTERVAL_MS: '1000',
    });
    const first = new KisRateLimiterService(redis, config);
    const second = new KisRateLimiterService(redis, config);
    const locksA = new RedisLockService(redis);
    const locksB = new RedisLockService(redis);
    const lockKey = `candles:lock:v1:smoke-${namespace}`;
    const assetId = `coordination-smoke-${namespace}`;
    const cacheInput = {
      assetId,
      range: '1d' as const,
      interval: '5m' as const,
      limit: 1,
      requestedDate: '2026-07-11',
    };
    const cache = new AssetCandlesCacheService(redis, {
      enabled: true,
      maxPayloadBytes: 2 * 1024 * 1024,
    });
    const response = buildResponse(assetId);
    const transitionConfig = readKisRateLimitConfig({
      KIS_APP_KEY: `${namespace}-transition`,
      KIS_API_ENVIRONMENT: 'real',
    });

    try {
      await expect(redis.ping()).resolves.toBe('PONG');
      const slot1 = await first.reserve('rest');
      const slot2 = await second.reserve('rest');
      expect(slot1.mode).toBe('redis');
      expect(slot2.delayMs).toBeGreaterThanOrEqual(100);
      expect(first.keyFor('oauth')).not.toBe(first.keyFor('rest'));
      expect(first.keyFor('rest')).toBe(second.keyFor('rest'));

      const acquired = await locksA.acquire(lockKey, 5000);
      expect(acquired.status).toBe('acquired');
      if (acquired.status !== 'acquired')
        throw new Error('smoke lock unavailable');
      await expect(locksB.acquire(lockKey, 5000)).resolves.toEqual({
        status: 'busy',
      });
      await expect(
        locksB.release({ ...acquired.lock, token: 'wrong-token' }),
      ).resolves.toBe(false);
      await expect(locksA.extend(acquired.lock, 5000)).resolves.toBe(true);

      const context = await cache.resolveContext(cacheInput);
      expect(context.status).toBe('resolved');
      if (context.status !== 'resolved') throw new Error('context unavailable');
      await expect(
        cache.setIfOwnerAndGeneration(context.context, response, {
          lockKey,
          lockToken: 'wrong-token',
        }),
      ).resolves.toEqual({ status: 'skipped_lock_lost' });
      await expect(
        cache.setIfOwnerAndGeneration(context.context, response, {
          lockKey,
          lockToken: acquired.lock.token,
        }),
      ).resolves.toMatchObject({ status: 'stored' });
      await cache.invalidateAsset(assetId);
      await expect(
        cache.setIfOwnerAndGeneration(context.context, response, {
          lockKey,
          lockToken: acquired.lock.token,
        }),
      ).resolves.toEqual({ status: 'skipped_generation_changed' });

      let failRedis = false;
      const transitionRedis = {
        eval: (...args: Parameters<RedisService['eval']>) =>
          failRedis
            ? Promise.reject(new RedisUnavailableError('simulated outage'))
            : redis.eval(...args),
      } as RedisService;
      const transition = new KisRateLimiterService(
        transitionRedis,
        transitionConfig,
      );
      await transition.reserve('rest');
      failRedis = true;
      expect((await transition.reserve('rest')).delayMs).toBeGreaterThan(0);
      failRedis = false;
      expect((await transition.reserve('rest')).delayMs).toBeGreaterThan(0);
      await redis.delete(transition.keyFor('rest'));
      await expect(locksA.release(acquired.lock)).resolves.toBe(true);
    } finally {
      // Delete only keys derived from this test's UUID namespace. Never scan or
      // flush the shared database.
      await Promise.allSettled([
        redis.delete(first.keyFor('rest')),
        redis.delete(first.keyFor('oauth')),
        redis.delete(lockKey),
        redis.delete(buildCandleGenerationKey(assetId)),
        redis.delete(buildCandleDataKey({ ...cacheInput, generation: 0 })),
        redis.delete(buildCandleDataKey({ ...cacheInput, generation: 1 })),
        redis.delete(
          `kis:rate:v1:${transitionConfig.environment}:${transitionConfig.appKeyHash}:rest`,
        ),
      ]);
      await redis.onModuleDestroy();
    }
  });
});

function buildResponse(assetId: string): AssetCandlesResponse {
  return {
    success: true,
    data: {
      state: 'empty',
      asset: {
        id: assetId,
        symbol: 'SMOKE',
        name: 'Smoke',
        assetType: 'crypto',
        market: 'BINANCE',
        priceCurrency: 'USD',
      },
      range: '1d',
      interval: '5m',
      requestedDate: '2026-07-11',
      candles: [],
      source: {
        provider: 'binance',
        endpoint: '/api/v3/klines',
        symbol: 'SMOKE',
        interval: '5m',
        requestedCount: 1,
        returnedCount: 0,
      },
    },
  };
}
