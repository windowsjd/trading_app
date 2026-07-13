import { spawnSync } from 'node:child_process';

const itPipeline =
  process.env.CANDLE_LIVE_PIPELINE_SMOKE === '1' ? it : it.skip;

describe('Candle live pipeline fixture smoke', () => {
  itPipeline(
    'composes Redis live state/PubSub, higher aggregation, finalization, cache invalidation, and REST correction',
    () => {
      const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const prepare = spawnSync(command, ['run', 'test:db:prepare'], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (prepare.status !== 0) {
        throw new Error(
          `Live candle migrate deploy failed:\n${prepare.stderr}`,
        );
      }
      const result = spawnSync(command, ['exec', 'tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `Live candle smoke failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stdout).toContain('candle live pipeline smoke ok');
    },
    130_000,
  );
});

const RUNNER = String.raw`
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { AssetType, CurrencyCode, MarketCandleSyncStatus } from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { RedisService } from './src/redis/redis.service';
import { readRedisConfig } from './src/redis/redis.config';
import { REDIS_COMPARE_AND_DELETE_SCRIPT } from './src/redis/redis-lua-scripts';
import { RedisLockService } from './src/redis/redis-lock.service';
import { MarketCandlesRepository } from './src/assets/market-candles.repository';
import { AssetCandlesCacheService } from './src/assets/asset-candles-cache.service';
import { buildCandleGenerationKey } from './src/assets/asset-candles-cache.keys';
import { MarketCandleAggregationService } from './src/assets/market-candle-aggregation.service';
import { LiveCandleHealthService } from './src/assets/live-candle-health.service';
import { readLiveCandleConfig } from './src/assets/live-candle.config';
import { LiveCandleStoreService, buildLiveCandleOwnerLeaseKey, buildLiveCandleStateKey, buildLiveCandlePointerKey, buildLiveCandleDedupeKey, LIVE_CANDLE_ACTIVE_INDEX_KEY } from './src/assets/live-candle-store.service';
import { LiveCandleOverlayService } from './src/assets/live-candle-overlay.service';
import { LiveCandlePublisherService, LIVE_CANDLE_PUBSUB_CHANNEL } from './src/assets/live-candle-publisher.service';
import { LiveCandlePipelineService } from './src/assets/live-candle-pipeline.service';
import { LiveCandleFinalizerService } from './src/assets/live-candle-finalizer.service';
import { MarketCandleReconciliationService } from './src/assets/market-candle-reconciliation.service';
import { readMarketCandleReconciliationConfig } from './src/assets/market-candle-reconciliation.config';

const prisma = new PrismaService();
const redisConfig = readRedisConfig();
if (!redisConfig.url) throw new Error('REDIS_URL is required');
const redis = new RedisService(redisConfig);
const subscriber = new IORedis(redisConfig.url, { lazyConnect: true, enableOfflineQueue: false });
const repository = new MarketCandlesRepository(prisma);
const cache = new AssetCandlesCacheService(redis, { enabled: true, maxPayloadBytes: 2097152 });
const aggregation = new MarketCandleAggregationService(repository);
const health = new LiveCandleHealthService();
const config = { ...readLiveCandleConfig({}), enabled: true, binanceEnabled: true, stateTtlSeconds: 300, finalizeGraceMs: 1 };
const store = new LiveCandleStoreService(redis, health, config);
const overlay = new LiveCandleOverlayService(store, repository, aggregation);
const publisher = new LiveCandlePublisherService(redis, overlay, health);
const locks = new RedisLockService(redis);
const hydrator = { hydrate: async () => ({ baseline: null, canonicalClosed: false }) };
const pipeline = new LiveCandlePipelineService(store, hydrator as never, publisher, health);
const finalizer = new LiveCandleFinalizerService(store, repository, cache, redis, locks, publisher, health, config);
const generation = randomUUID();
const leaseKey = buildLiveCandleOwnerLeaseKey('binance');
const namespace = randomUUID();
let assetId = '';
const openTime = new Date('2026-07-13T00:55:00.000Z');
const stateKey = () => buildLiveCandleStateKey(assetId, openTime, generation);
const events: any[] = [];

const normalized = (final: boolean) => ({
  provider: 'binance' as const, source: 'binance_spot_ws_5m_kline', assetId,
  assetType: AssetType.crypto, market: 'BINANCE', symbol: 'SMOKEUSDT',
  eventTime: new Date(final ? '2026-07-13T00:59:59.999Z' : '2026-07-13T00:57:00.000Z'),
  receivedAt: new Date(final ? '2026-07-13T01:00:00.000Z' : '2026-07-13T00:57:01.000Z'),
  price: final ? '105.00000000' : '104.00000000', tradeQuantity: null, amount: null,
  eventId: final ? 'fixture-final' : 'fixture-live', sequence: final ? '2' : '1',
  marketSession: 'continuous' as const, delayed: false, openTime,
  closeTime: new Date('2026-07-13T01:00:00.000Z'), mode: 'absolute' as const,
  absolute: { open: '103.00000000', high: '106.00000000', low: '102.00000000', close: final ? '105.00000000' : '104.00000000', volume: final ? '5.00000000' : '4.00000000', amount: final ? '525.00000000' : '416.00000000', providerFinal: final },
});

async function main() {
  await prisma.$connect();
  await subscriber.connect();
  await subscriber.subscribe(LIVE_CANDLE_PUBSUB_CHANNEL);
  subscriber.on('message', (_channel, message) => events.push(JSON.parse(message)));
  try {
    const asset = await prisma.asset.create({ data: { symbol: 'SM' + Date.now().toString(36).toUpperCase() + 'USDT', name: 'Live smoke', market: 'BINANCE-' + namespace, currencyCode: CurrencyCode.USD, priceCurrency: CurrencyCode.USD, settlementCurrency: CurrencyCode.USD, assetType: AssetType.crypto } });
    assetId = asset.id;
    const historical = Array.from({ length: 11 }, (_, index) => {
      const time = new Date(Date.parse('2026-07-13T00:00:00.000Z') + index * 300000);
      return { assetId, interval: '5m' as const, openTime: time, closeTime: new Date(time.getTime()+300000), open: String(100+index), high: String(101+index), low: String(99+index), close: String(100+index), volume: '1', amount: '100', isClosed: true, sourceProvider: 'fixture_history', sourceUpdatedAt: new Date(time.getTime()+299000) };
    });
    await repository.upsertMany(historical);
    assert.equal(await redis.setNxPx(leaseKey, generation, 120000), true, 'provider owner lease is already held');

    await pipeline.process({ event: normalized(false), ownerGeneration: generation, ownerLeaseKey: leaseKey });
    await new Promise(resolve => setTimeout(resolve, 100));
    const current = await store.getCurrent(assetId);
    assert.equal(current?.close, '104.00000000');
    assert.ok(events.some(event => event.interval === '5m'));
    assert.ok(events.some(event => event.interval === '15m'));
    assert.ok(events.some(event => event.interval === '1h'));

    await pipeline.process({ event: normalized(true), ownerGeneration: generation, ownerLeaseKey: leaseKey });
    const generationBefore = Number(await redis.get(buildCandleGenerationKey(assetId)) ?? '0');
    await finalizer.runOnce(new Date('2026-07-13T01:00:00.010Z'));
    const stored = await repository.findRange({ assetId, interval: '5m', from: openTime, to: new Date('2026-07-13T01:00:00.000Z') });
    assert.equal(stored[0]?.isClosed, true);
    assert.equal(Number(await redis.get(buildCandleGenerationKey(assetId))), generationBefore + 1);

    const sync = { syncAsset: async () => {
      await repository.upsertMany([{ assetId, interval: '5m', openTime, closeTime: new Date('2026-07-13T01:00:00.000Z'), open: '103', high: '106', low: '102', close: '105.5', volume: '5', amount: '527.5', isClosed: true, sourceProvider: 'fixture_rest', sourceUpdatedAt: new Date('2026-07-13T01:01:00.000Z') }]);
      await cache.invalidateAsset(assetId);
      return { feeds: [{ status: MarketCandleSyncStatus.completed }] };
    }};
    const reconciliation = new MarketCandleReconciliationService(prisma, repository, sync as never, store, publisher, readMarketCandleReconciliationConfig({}));
    const repaired = await reconciliation.reconcile({ assetIds: [assetId], market: 'CRYPTO', targets: ['5m'], from: openTime, to: new Date('2026-07-13T01:00:00.000Z'), now: new Date('2026-07-13T01:02:00.000Z') });
    assert.equal(repaired.correctedRows, 1);
    assert.equal((await repository.findRange({ assetId, interval: '5m', from: openTime, to: new Date('2026-07-13T01:00:00.000Z') }))[0].close.toFixed(8), '105.50000000');
    console.log('candle live pipeline smoke ok');
  } finally {
    if (assetId) {
      await redis.removeFromSortedSet(LIVE_CANDLE_ACTIVE_INDEX_KEY, [stateKey()]);
      await Promise.all([
        redis.delete(stateKey()), redis.delete(buildLiveCandlePointerKey(assetId)), redis.delete(buildCandleGenerationKey(assetId)),
        redis.delete(buildLiveCandleDedupeKey(assetId, openTime, generation, 'fixture-live')),
        redis.delete(buildLiveCandleDedupeKey(assetId, openTime, generation, 'fixture-final')),
      ]);
      await prisma.marketCandle.deleteMany({ where: { assetId } });
      await prisma.asset.delete({ where: { id: assetId } });
    }
    await redis.eval(REDIS_COMPARE_AND_DELETE_SCRIPT, [leaseKey], [generation]);
    await subscriber.unsubscribe(LIVE_CANDLE_PUBSUB_CHANNEL).catch(() => undefined);
    await subscriber.quit().catch(() => subscriber.disconnect());
    await redis.onModuleDestroy();
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'smoke failed'); process.exit(1); });
`;
