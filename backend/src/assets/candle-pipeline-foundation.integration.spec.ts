import { spawnSync } from 'node:child_process';

const itFoundation =
  process.env.CANDLE_PIPELINE_FOUNDATION_SMOKE === '1' ? it : it.skip;

describe('Candle pipeline foundation smoke', () => {
  itFoundation(
    'composes PostgreSQL storage/retention with Redis cache/locks/rate slots',
    () => {
      const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const prepare = spawnSync(command, ['run', 'test:db:prepare'], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (prepare.status !== 0)
        throw new Error(`Foundation migrate deploy failed:\n${prepare.stderr}`);
      const result = spawnSync(command, ['exec', 'tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `Foundation smoke failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stdout).toContain('candle pipeline foundation smoke ok');
    },
    130_000,
  );
});

const RUNNER = String.raw`
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssetType, CurrencyCode } from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { RedisService } from './src/redis/redis.service';
import { readRedisConfig } from './src/redis/redis.config';
import { RedisLockService } from './src/redis/redis-lock.service';
import { MarketCandlesRepository } from './src/assets/market-candles.repository';
import { MarketCandleRetentionService } from './src/assets/market-candle-retention.service';
import { AssetCandlesCacheService } from './src/assets/asset-candles-cache.service';
import { AssetCandlesSingleFlightService } from './src/assets/asset-candles-single-flight.service';
import { buildCandleDataKey, buildCandleGenerationKey } from './src/assets/asset-candles-cache.keys';
import { readKisRateLimitConfig } from './src/providers/kis/coordination/kis-rate-limit.config';
import { KisRateLimiterService } from './src/providers/kis/coordination/kis-rate-limiter.service';

const prisma = new PrismaService();
const redis = new RedisService(readRedisConfig());
const repository = new MarketCandlesRepository(prisma);
const retention = new MarketCandleRetentionService(repository, { retentionDays: 35, batchSize: 2, maxBatches: 1000 }, async () => undefined);
const cache = new AssetCandlesCacheService(redis, { enabled: true, maxPayloadBytes: 2097152 });
const locksA = new RedisLockService(redis);
const locksB = new RedisLockService(redis);
const singleFlight = new AssetCandlesSingleFlightService(cache, locksA, { lockTtlMs: 30000, waitTimeoutMs: 35000, pollIntervalMs: 10, renewIntervalMs: 10000 });
const namespace = randomUUID();
const market = 'FOUNDATION-' + namespace;
let assetId = '';
const now = new Date('2026-07-11T00:00:00.000Z');
const old = new Date('2026-06-01T00:00:00.000Z');
const input = { assetId: '', range: '1d' as const, interval: '5m' as const, limit: 100, requestedDate: '2026-07-11' };
const response = { success: true as const, data: { state: 'empty' as const, asset: { id: '', symbol: 'FOUND', name: 'Foundation', assetType: AssetType.crypto, market, priceCurrency: CurrencyCode.USD }, range: '1d' as const, interval: '5m' as const, requestedDate: '2026-07-11', candles: [], source: { provider: 'binance' as const, endpoint: '/api/v3/klines' as const, symbol: 'FOUND', interval: '5m' as const, requestedCount: 100, returnedCount: 0 } } };
const rateConfig = readKisRateLimitConfig({ KIS_APP_KEY: namespace, KIS_API_ENVIRONMENT: 'real' });
const limiterA = new KisRateLimiterService(redis, rateConfig);
const limiterB = new KisRateLimiterService(redis, rateConfig);
const sharedLockKey = 'candles:lock:v1:foundation-' + namespace;
const raceLockKey = sharedLockKey + '-race';

async function main() {
  await prisma.$connect();
  try {
    assert.equal(await redis.ping(), 'PONG');
    const asset = await prisma.asset.create({ data: { symbol: 'F' + Date.now().toString(36).toUpperCase(), name: 'Foundation', market, currencyCode: CurrencyCode.USD, priceCurrency: CurrencyCode.USD, settlementCurrency: CurrencyCode.USD, assetType: AssetType.crypto } });
    assetId = asset.id; input.assetId = assetId; response.data.asset.id = assetId;
    const candle = (interval: '5m' | '1d' | '1w', openTime: Date, isClosed: boolean) => ({ assetId, interval, openTime, closeTime: new Date(openTime.getTime() + 300000), open: '100', high: '101', low: '99', close: '100', volume: '1', amount: '100', isClosed, sourceProvider: 'foundation', sourceUpdatedAt: now });
    await repository.upsertMany([candle('5m', old, true), candle('5m', new Date(old.getTime()+300000), false), candle('1d', old, true), candle('1w', old, true)]);
    assert.equal((await repository.findRange({ assetId, interval: '5m', from: old, to: now })).length, 2);

    assert.equal((await cache.set(input, response)).status, 'stored');
    assert.equal((await cache.get(input)).status, 'hit');
    await cache.invalidateAsset(assetId);
    let loads = 0;
    await Promise.all(Array.from({ length: 10 }, () => singleFlight.getOrLoad({ cacheKeyInput: input, loader: async () => { loads += 1; return response; } })));
    assert.equal(loads, 1);

    const shared = await locksA.acquire(sharedLockKey, 5000);
    assert.equal(shared.status, 'acquired');
    assert.equal((await locksB.acquire(sharedLockKey, 5000)).status, 'busy');
    if (shared.status === 'acquired') await locksA.release(shared.lock);

    const context = await cache.resolveContext(input);
    assert.equal(context.status, 'resolved');
    const race = await locksA.acquire(raceLockKey, 5000);
    if (context.status !== 'resolved' || race.status !== 'acquired') throw new Error('race setup failed');
    await cache.invalidateAsset(assetId);
    assert.equal((await cache.setIfOwnerAndGeneration(context.context, response, { lockKey: race.lock.key, lockToken: race.lock.token })).status, 'skipped_generation_changed');
    assert.equal((await cache.setIfOwnerAndGeneration(context.context, response, { lockKey: race.lock.key, lockToken: 'wrong' })).status, 'skipped_lock_lost');
    await locksA.release(race.lock);

    const rate1 = await limiterA.reserve('rest');
    const rate2 = await limiterB.reserve('rest');
    assert.equal(rate1.mode, 'redis'); assert(rate2.delayMs >= 100);
    const retained = await retention.run({ now, batchSize: 2 });
    assert.equal(retained.deletedCount, 1);
    const survivors = await prisma.marketCandle.findMany({ where: { assetId } });
    assert(survivors.some((row) => row.interval === '5m' && !row.isClosed));
    assert(survivors.some((row) => row.interval === '1d'));
    assert(survivors.some((row) => row.interval === '1w'));
    console.log('candle pipeline foundation smoke ok');
  } finally {
    if (assetId) await prisma.marketCandle.deleteMany({ where: { assetId } });
    await prisma.asset.deleteMany({ where: { market } });
    const cleanupAssetId = assetId || namespace;
    const cleanupInput = { ...input, assetId: cleanupAssetId };
    const keys = [buildCandleGenerationKey(cleanupAssetId), buildCandleDataKey({ ...cleanupInput, generation: 0 }), buildCandleDataKey({ ...cleanupInput, generation: 1 }), buildCandleDataKey({ ...cleanupInput, generation: 2 }), limiterA.keyFor('rest'), limiterA.keyFor('oauth'), sharedLockKey, raceLockKey];
    await Promise.allSettled(keys.map((key) => redis.delete(key)));
    await redis.onModuleDestroy(); await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
`;
