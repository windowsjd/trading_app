import { randomUUID } from 'node:crypto';
import { RedisLockService } from '../../../redis/redis-lock.service';
import { readRedisConfig } from '../../../redis/redis.config';
import { RedisService } from '../../../redis/redis.service';
import { readKisRateLimitConfig } from './kis-rate-limit.config';
import { KisRateLimiterService } from './kis-rate-limiter.service';

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
      await expect(locksA.release(acquired.lock)).resolves.toBe(true);
    } finally {
      // Delete only keys derived from this test's UUID namespace. Never scan or
      // flush the shared database.
      await Promise.allSettled([
        redis.delete(first.keyFor('rest')),
        redis.delete(first.keyFor('oauth')),
        redis.delete(lockKey),
      ]);
      await redis.onModuleDestroy();
    }
  });
});
