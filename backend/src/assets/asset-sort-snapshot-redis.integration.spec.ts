import { createHash, randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { RedisService } from '../redis/redis.service';
import { readRedisConfig } from '../redis/redis.config';
import {
  ASSET_SORT_MAX_SNAPSHOTS,
  ASSET_SORT_REUSE_SECONDS,
  ASSET_SORT_TTL_SECONDS,
  STORE_ASSET_SORT_SNAPSHOT,
} from './asset-sort-snapshot-cache';

const redisTest =
  process.env.ASSET_SORT_REDIS_INTEGRATION === '1' ? it : it.skip;

describe('Market sort snapshot publication on real Redis', () => {
  redisTest(
    'bounds payloads/pointers, retains newer pointers, and expires both lifetimes',
    async () => {
      const config = readRedisConfig();
      if (!config.url) throw new Error('Set an isolated test REDIS_URL');
      const redis = new RedisService(config);
      const reader = new RedisService(config);
      const raw = new IORedis(config.url);
      const prefix = `test:asset-sort:${randomUUID()}:`;
      const latest = (key: string) =>
        prefix + 'latest:' + createHash('sha1').update(key).digest('hex');
      const store = async (
        token: string,
        key: string,
        now: number,
        ttl = ASSET_SORT_TTL_SECONDS,
        reuse = ASSET_SORT_REUSE_SECONDS,
      ) => {
        await redis.eval(
          STORE_ASSET_SORT_SNAPSHOT,
          [prefix + token, latest(key), prefix + 'index'],
          [
            prefix,
            token,
            JSON.stringify({ key, token, assets: [], priceErrors: [] }),
            String(ttl),
            String(reuse),
            String(ASSET_SORT_MAX_SNAPSHOTS),
            String(now),
          ],
        );
      };
      try {
        const now = Date.now();
        await store('old', 'same-filter', now);
        await store('new', 'same-filter', now + 1);
        for (let i = 0; i < 199; i++)
          await store(`search-${i}`, `search-${i}`, now + 2 + i);
        expect(await reader.get(prefix + 'old')).toBeNull();
        expect(await reader.get(latest('same-filter'))).toBe('new');
        expect(await reader.get(prefix + 'new')).not.toBeNull();
        expect(await raw.zcard(prefix + 'index')).toBe(200);
        expect((await raw.keys(prefix + '*')).length).toBe(401); // 200 payloads, 200 pointers, index
        expect(await raw.ttl(prefix + 'new')).toBeGreaterThanOrEqual(599);
        expect(await raw.ttl(latest('same-filter'))).toBeLessThanOrEqual(2);
        await store('last', 'last-prefix', now + 202);
        expect(await reader.get(prefix + 'new')).toBeNull();
        expect(await reader.get(latest('same-filter'))).toBeNull();
        await store('expires', 'short-test-only', now + 203, 2, 1);
        await new Promise((resolve) => setTimeout(resolve, 2100));
        expect(await reader.get(prefix + 'expires')).toBeNull();
        expect(await reader.get(latest('short-test-only'))).toBeNull();
      } finally {
        const keys = await raw.keys(prefix + '*');
        if (keys.length) await raw.del(...keys);
        raw.disconnect();
        await redis.onModuleDestroy();
        await reader.onModuleDestroy();
      }
    },
    15000,
  );
});
