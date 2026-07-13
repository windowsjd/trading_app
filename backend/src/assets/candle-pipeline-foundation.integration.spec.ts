import { spawnSync } from 'node:child_process';

const itFoundation =
  process.env.CANDLE_PIPELINE_FOUNDATION_SMOKE === '1' ||
  process.env.CANDLE_SERVING_DB_SMOKE === '1'
    ? it
    : it.skip;

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
import { MarketCandleSyncStateRepository } from './src/assets/market-candle-sync-state.repository';
import { MarketCandleAggregationService } from './src/assets/market-candle-aggregation.service';
import { CandleReadPlanBuilder } from './src/assets/candle-read-plan.builder';
import { CandleResponseBuilder } from './src/assets/candle-response.builder';
import { CandleDatabaseLoader } from './src/assets/candle-database.loader';
import { CandleServingService } from './src/assets/candle-serving.service';

const prisma = new PrismaService();
const redis = new RedisService(readRedisConfig());
const repository = new MarketCandlesRepository(prisma);
const retention = new MarketCandleRetentionService(repository, { retentionDays: 35, batchSize: 2, maxBatches: 1000 }, async () => undefined);
let cacheNow = new Date('2026-07-11T00:00:00.000Z');
const cache = new AssetCandlesCacheService(redis, { enabled: true, maxPayloadBytes: 2097152, currentStaleTtlSeconds: 300, historicalFreshTtlSeconds: 900, historicalStaleTtlSeconds: 3600, emptyFreshTtlSeconds: 10, emptyStaleTtlSeconds: 60 }, () => cacheNow);
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
const servingConfig = { mode: 'database' as const, currentFreshnessMs: 60000, onDemandRefreshEnabled: true, onDemandRefreshMaxDurationMs: 1000, onDemandRefreshMaxPages: 10, onDemandRefreshMaxRows: 5000, staleWaiterMaxWaitMs: 50, maxManagedFiveMinuteRangeMs: 35*86400000, maxManagedPeriodRangeMs: 365*86400000, maxOnDemandRepairRangeMs: 2*86400000 };
const rateConfig = readKisRateLimitConfig({ KIS_APP_KEY: namespace, KIS_API_ENVIRONMENT: 'real' });
const limiterA = new KisRateLimiterService(redis, rateConfig);
const limiterB = new KisRateLimiterService(redis, rateConfig);
const sharedLockKey = 'candles:lock:v1:foundation-' + namespace;
const raceLockKey = sharedLockKey + '-race';

async function main() {
  await prisma.$connect();
  try {
    assert.equal(await redis.ping(), 'PONG');
    const asset = await prisma.asset.create({ data: { symbol: 'F' + Date.now().toString(36).toUpperCase() + 'USDT', name: 'Foundation', market, currencyCode: CurrencyCode.USD, priceCurrency: CurrencyCode.USD, settlementCurrency: CurrencyCode.USD, assetType: AssetType.crypto } });
    assetId = asset.id; input.assetId = assetId; response.data.asset.id = assetId;
    const candle = (interval: '5m' | '1d' | '1w', openTime: Date, isClosed: boolean) => ({ assetId, interval, openTime, closeTime: new Date(openTime.getTime() + 300000), open: '100', high: '101', low: '99', close: '100', volume: '1', amount: '100', isClosed, sourceProvider: 'foundation', sourceUpdatedAt: now });
    const recent5m = Array.from({ length: 48 }, (_, index) => candle('5m', new Date(now.getTime() - (48-index)*300000), true));
    await repository.upsertMany([candle('5m', old, true), candle('5m', new Date(old.getTime()+300000), false), ...recent5m, candle('1d', new Date(now.getTime()-86400000), true), candle('1w', new Date(now.getTime()-7*86400000), true)]);
    assert.equal((await repository.findRange({ assetId, interval: '5m', from: old, to: now })).length, 50);

    assert.equal((await cache.set(input, response)).status, 'stored');
    assert.equal((await cache.get(input)).status, 'fresh');
    await cache.invalidateAsset(assetId);
    let loads = 0;
    await Promise.all(Array.from({ length: 10 }, () => singleFlight.getOrLoad({ cacheKeyInput: input, loader: async () => { loads += 1; return response; } })));
    assert.equal(loads, 1);

    const stateRepository = new MarketCandleSyncStateRepository(prisma);
    for (const feed of ['5m', '1d', '1w'] as const) {
      const state = await stateRepository.createRunning({ assetId, feed, sourceProvider: 'binance_klines', mode: 'repair', targetFrom: new Date(now.getTime()-8*86400000), targetTo: now });
      await stateRepository.markCompleted(state.id, now, { coverageComplete: true, completionReason: 'target_reached', coveredFrom: new Date(now.getTime()-8*86400000), coveredTo: now });
    }
    const plans = new CandleReadPlanBuilder(servingConfig);
    const responses = new CandleResponseBuilder();
    const aggregation = new MarketCandleAggregationService(repository);
    const database = new CandleDatabaseLoader(plans, repository, stateRepository, aggregation, responses, servingConfig);
    const noRefresh = { syncAsset: async () => { throw new Error('provider refresh should not run'); } };
    const serving = new CandleServingService(plans, database, cache, singleFlight, noRefresh as never, servingConfig);
    const parsed = { range: '1d' as const, rangeProvided: true, rangeStartAt: new Date(now.getTime()-86400000), rangeEndAt: now, interval: '5m' as const, intervalMinutes: 5, limit: 100, requestedDate: '2026-07-11', toHHmmss: '000000', toInstant: now, dateProvided: true, toProvided: true, includePrevious: true, explicitDate: false, explicitTo: false, clock: now };
    const assetView = { ...asset, name: 'Foundation' };
    const firstServed = await serving.serve(assetView, parsed, async () => { throw new Error('legacy should not run'); });
    assert.equal(firstServed.data.state, 'available');
    const secondServed = await serving.serve(assetView, parsed, async () => { throw new Error('legacy should not run'); });
    assert.deepEqual(secondServed, firstServed);
    for (const interval of ['15m','30m','1h','4h'] as const) {
      const loaded = await database.load(assetView, { ...parsed, interval }, plans.build(assetView, { ...parsed, interval }));
      assert.equal(loaded.response?.data.state, 'available');
    }
    await cache.invalidateAsset(assetId);
    const afterGeneration = await serving.serve(assetView, parsed, async () => { throw new Error('legacy should not run'); });
    assert.equal(afterGeneration.data.state, 'available');

    cacheNow = new Date(cacheNow.getTime()+31000);
    const staleContext = await cache.get({ ...input, latest: true });
    if (staleContext.status !== 'stale') {
      await cache.set({ ...input, latest: true }, firstServed);
      cacheNow = new Date(cacheNow.getTime()+31000);
    }
    const missing = { ...await database.load(assetView, parsed), state: 'missing' as const, fresh: false, response: null };
    const failingDatabase = { load: async () => missing };
    const failedSync = { syncAsset: async () => ({ assetId, feeds: [{ status: 'failed', complete: false, writtenRows: 0, errorCode: 'PROVIDER_CALL_FAILED', stopReason: 'provider_error' }] }) };
    const staleServing = new CandleServingService(plans, failingDatabase as never, cache, singleFlight, failedSync as never, servingConfig);
    const staleResult = await staleServing.serve(assetView, parsed, async () => { throw new Error('legacy should not run'); });
    assert.equal(staleResult.data.state, 'available');

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
    if (assetId) await prisma.marketCandleSyncState.deleteMany({ where: { assetId } });
    if (assetId) await prisma.marketCandle.deleteMany({ where: { assetId } });
    await prisma.asset.deleteMany({ where: { market } });
    const cleanupAssetId = assetId || namespace;
    const cleanupInput = { ...input, assetId: cleanupAssetId };
    const servingCleanupInput = { ...cleanupInput, includePrevious: true, latest: true, explicitTo: false };
    const keys = [buildCandleGenerationKey(cleanupAssetId), buildCandleDataKey({ ...cleanupInput, generation: 0 }), buildCandleDataKey({ ...cleanupInput, generation: 1 }), buildCandleDataKey({ ...cleanupInput, generation: 2 }), buildCandleDataKey({ ...servingCleanupInput, generation: 0 }), buildCandleDataKey({ ...servingCleanupInput, generation: 1 }), buildCandleDataKey({ ...servingCleanupInput, generation: 2 }), limiterA.keyFor('rest'), limiterA.keyFor('oauth'), sharedLockKey, raceLockKey];
    await Promise.allSettled(keys.map((key) => redis.delete(key)));
    await redis.onModuleDestroy(); await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
`;
