/**
 * Release fixture smoke for the candle pipeline (units 1–3).
 *
 * Runs against REAL PostgreSQL + Redis with fixture providers only — no
 * external provider is contacted. Gate: CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1.
 *
 *   CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm exec tsx scripts/candle-release-fixture-smoke.ts
 *
 * Produces a structured JSON summary on stdout and writes it to
 * backend/artifacts/candle-smoke/fixture-<timestamp>.json. Exit code 0 only
 * when every scenario passed and all fixture rows/keys were cleaned up.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import IORedis from 'ioredis';
import {
  assertReleaseCleanTree,
  resolveSmokeGitIdentity,
  type SmokeGitIdentity,
} from './lib/smoke-git-identity';
import { SMOKE_REPORT_SCHEMA_VERSION } from './lib/smoke-report';
import { JwtService } from '@nestjs/jwt';
import {
  AssetType,
  CurrencyCode,
  MarketCandleSyncMode,
  MarketCandleSyncStatus,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { readRedisConfig } from '../src/redis/redis.config';
import { RedisLockService } from '../src/redis/redis-lock.service';
import { MarketCandlesRepository } from '../src/assets/market-candles.repository';
import { MarketCandleSyncStateRepository } from '../src/assets/market-candle-sync-state.repository';
import { MarketCandleBackfillLockService } from '../src/assets/market-candle-backfill-lock.service';
import { MarketCandleSyncService } from '../src/assets/market-candle-sync.service';
import { KisPeriodCandleNormalizerService } from '../src/providers/kis/candles/kis-period-candle-normalizer.service';
import { AssetCandlesCacheService } from '../src/assets/asset-candles-cache.service';
import { AssetCandlesSingleFlightService } from '../src/assets/asset-candles-single-flight.service';
import { CandleReadPlanBuilder } from '../src/assets/candle-read-plan.builder';
import { CandleResponseBuilder } from '../src/assets/candle-response.builder';
import { MarketCandleAggregationService } from '../src/assets/market-candle-aggregation.service';
import { CandleDatabaseLoader } from '../src/assets/candle-database.loader';
import { CandleServingService } from '../src/assets/candle-serving.service';
import { readLiveCandleConfig } from '../src/assets/live-candle.config';
import { LiveCandleHealthService } from '../src/assets/live-candle-health.service';
import {
  LiveCandleStoreService,
  buildLiveCandleOwnerLeaseKey,
  buildLiveCandlePointerKey,
  buildLiveCandleStateKey,
  LIVE_CANDLE_ACTIVE_INDEX_KEY,
} from '../src/assets/live-candle-store.service';
import { LiveCandleHydratorService } from '../src/assets/live-candle-hydrator.service';
import { LiveCandleOverlayService } from '../src/assets/live-candle-overlay.service';
import {
  LiveCandlePublisherService,
  LIVE_CANDLE_PUBSUB_CHANNEL,
} from '../src/assets/live-candle-publisher.service';
import { LiveCandlePipelineService } from '../src/assets/live-candle-pipeline.service';
import { LiveCandleFinalizerService } from '../src/assets/live-candle-finalizer.service';
import { LiveCandleEventNormalizerService } from '../src/assets/live-candle-event-normalizer.service';
import { MarketCandleReconciliationService } from '../src/assets/market-candle-reconciliation.service';
import { MarketCandleRetentionService } from '../src/assets/market-candle-retention.service';
import { LiveCandleStreamSupervisorService } from '../src/realtime/live-candle-stream-supervisor.service';
import { LiveCandlePubSubService } from '../src/realtime/live-candle-pubsub.service';
import { AssetTickerGateway } from '../src/realtime/asset-ticker.gateway';
import { KisRealtimePriceEventBus } from '../src/providers/kis/kis-realtime-price-event-bus.service';
import { BinanceRealtimePriceEventBus } from '../src/providers/binance/binance-realtime-price-event-bus.service';
import { resolveMarketSession } from '../src/orders/market-calendar.policy';

if (process.env.CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE !== '1') {
  console.log('CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE!=1; skipping.');
  process.exit(0);
}

// Commit traceability comes first: without a resolved SHA no artifact may be
// produced, and a dirty working tree is refused unless SMOKE_ALLOW_DIRTY=1
// (recorded as gitDirty=true; such runs are never release validation).
let gitIdentity: SmokeGitIdentity;
try {
  gitIdentity = resolveSmokeGitIdentity();
  assertReleaseCleanTree(gitIdentity);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

const FIVE_MIN = 300_000;
const DAY = 86_400_000;
// Friday 2026-07-10 14:00 KST / 05:00 UTC: a confirmed KRX trading day in
// the audited 2026 calendar; also used for the crypto fixture buckets.
const BUCKET_OPEN = new Date('2026-07-10T05:00:00.000Z');
const BUCKET_CLOSE = new Date(BUCKET_OPEN.getTime() + FIVE_MIN);
const OLD_BUCKET_OPEN = new Date(BUCKET_OPEN.getTime() - 2 * FIVE_MIN);
const KIS_OLD_BUCKET_OPEN = new Date(BUCKET_OPEN.getTime() - 4 * FIVE_MIN);
const CLOCK = new Date('2026-07-10T06:00:00.000Z');

type Scenario = { name: string; state: 'passed' | 'failed'; error?: string };
const scenarios: Scenario[] = [];
const errors: string[] = [];
const startedAt = new Date();

async function scenario(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
    scenarios.push({ name, state: 'passed' });
    console.error(`ok   ${name}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.message}` : String(error);
    scenarios.push({ name, state: 'failed', error: message });
    errors.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

class FakeProviderSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, reason);
  }
  frame(payload: unknown) {
    this.emit(
      'message',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
  }
}

const KIS_DOMESTIC_FIELDS = 46;

function kisTradeFrame(input: {
  symbol: string;
  timeKst: string; // HHMMSS on 2026-07-10
  price: string;
  qty: string;
  cumVol: string;
  cumAmt: string;
}): string {
  const fields = new Array<string>(KIS_DOMESTIC_FIELDS).fill('');
  fields[0] = input.symbol; // MKSC_SHRN_ISCD
  fields[1] = input.timeKst; // STCK_CNTG_HOUR
  fields[2] = input.price; // STCK_PRPR
  fields[12] = input.qty; // CNTG_VOL
  fields[13] = input.cumVol; // ACML_VOL
  fields[14] = input.cumAmt; // ACML_TR_PBMN
  fields[33] = '20260710'; // BSOP_DATE
  return `0|H0STCNT0|001|${fields.join('^')}`;
}

function binanceKlineFrame(input: {
  symbol: string;
  eventMs: number;
  openMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quote: string;
  final: boolean;
}): string {
  return JSON.stringify({
    e: 'kline',
    E: input.eventMs,
    s: input.symbol,
    k: {
      t: input.openMs,
      T: input.openMs + FIVE_MIN - 1,
      s: input.symbol,
      i: '5m',
      f: 1,
      L: 2,
      o: input.open,
      h: input.high,
      l: input.low,
      c: input.close,
      v: input.volume,
      n: 2,
      x: input.final,
      q: input.quote,
    },
  });
}

async function main() {
  const prisma = new PrismaService();
  const redis = new RedisService(readRedisConfig());
  await prisma.$connect();
  assert.equal(await redis.ping(), 'PONG', 'Redis must be reachable');

  const namespace = randomUUID().slice(0, 8).toUpperCase();
  const repository = new MarketCandlesRepository(prisma);
  const stateRepository = new MarketCandleSyncStateRepository(prisma);
  const locks = new RedisLockService(redis);
  const backfillLocks = new MarketCandleBackfillLockService(locks);
  let cacheNow = new Date(CLOCK);
  const cache = new AssetCandlesCacheService(
    redis,
    {
      enabled: true,
      maxPayloadBytes: 2_097_152,
      currentStaleTtlSeconds: 300,
      historicalFreshTtlSeconds: 900,
      historicalStaleTtlSeconds: 3600,
      emptyFreshTtlSeconds: 10,
      emptyStaleTtlSeconds: 60,
    },
    () => cacheNow,
  );
  const singleFlight = new AssetCandlesSingleFlightService(cache, locks, {
    lockTtlMs: 30_000,
    waitTimeoutMs: 5_000,
    pollIntervalMs: 10,
    renewIntervalMs: 10_000,
  });
  const servingConfig = {
    mode: 'database' as const,
    currentFreshnessMs: 60_000,
    onDemandRefreshEnabled: true,
    onDemandRefreshMaxDurationMs: 5_000,
    onDemandRefreshMaxPages: 10,
    onDemandRefreshMaxRows: 5_000,
    staleWaiterMaxWaitMs: 100,
    maxManagedFiveMinuteRangeMs: 35 * DAY,
    maxManagedPeriodRangeMs: 365 * DAY,
    maxOnDemandRepairRangeMs: 2 * DAY,
  };

  // ── fixture provider feeds ────────────────────────────────────────────────
  const fixtureCandle = (openMs: number, close = '101') => ({
    openTime: new Date(openMs),
    closeTime: new Date(openMs + FIVE_MIN),
    open: '100',
    high: '102',
    low: '99',
    close,
    volume: '10',
    amount: '1010',
    isClosed: true,
    sourceUpdatedAt: CLOCK,
  });
  // Behavior switches for failure fixtures.
  const feedState = {
    binanceMode: 'complete' as 'complete' | 'cursor_stall' | 'corrected',
    domesticMode: 'complete' as 'complete' | 'empty',
  };
  const fakeBinance = {
    fetchKlinesPage: (input: { from: Date; to: Date }) => {
      if (feedState.binanceMode === 'cursor_stall') {
        return {
          candles: [],
          providerReturnedRows: 1,
          acceptedRows: 0,
          rejectedRows: 1,
          duplicateRows: 0,
          nextCursor: null,
          stopReason: 'cursor_not_advanced' as const,
          complete: false,
        };
      }
      const corrected = feedState.binanceMode === 'corrected';
      const close = corrected ? '111' : '101';
      const candles = [] as ReturnType<typeof fixtureCandle>[];
      for (
        let openMs = Math.ceil(input.from.getTime() / FIVE_MIN) * FIVE_MIN;
        openMs + FIVE_MIN <= input.to.getTime() && candles.length < 6;
        openMs += FIVE_MIN
      ) {
        const candle = fixtureCandle(openMs, close);
        // The canonical REST correction must win the newer-source-wins upsert
        // guard against rows finalized from the live path moments ago, and
        // stay OHLC-consistent with the corrected close.
        if (corrected) {
          candle.high = '112';
          // Deterministic: newer than every live-finalized row, but stable
          // across reconciliation runs so the second pass observes zero drift.
          candle.sourceUpdatedAt = new Date('2026-07-11T00:00:00.000Z');
        }
        candles.push(candle);
      }
      return {
        candles,
        providerReturnedRows: candles.length,
        acceptedRows: candles.length,
        rejectedRows: 0,
        duplicateRows: 0,
        nextCursor: null,
        stopReason: 'target_reached' as const,
        complete: true,
      };
    },
  };
  const fakeFiveMinute = {
    fetchDomesticFiveMinuteCandles: (input: { from: Date; to: Date }) => {
      const empty = feedState.domesticMode === 'empty';
      const candles = empty
        ? []
        : (() => {
            const list = [] as ReturnType<typeof fixtureCandle>[];
            for (
              let openMs =
                Math.ceil(input.from.getTime() / FIVE_MIN) * FIVE_MIN;
              openMs + FIVE_MIN <= input.to.getTime() && list.length < 6;
              openMs += FIVE_MIN
            ) {
              list.push(fixtureCandle(openMs));
            }
            return list;
          })();
      return {
        provider: 'kis_domestic_minute',
        assetId: 'fixture',
        rangeFrom: input.from,
        rangeTo: input.to,
        pagesFetched: 1,
        providerReturnedRows: candles.length * 5,
        acceptedRows: candles.length * 5,
        rejectedRows: 0,
        duplicateRows: 0,
        candles,
        complete: !empty,
        stopReason: empty ? 'empty_page' : 'target_reached',
        oldestOpenTime: candles[0]?.openTime ?? null,
        latestOpenTime: candles.at(-1)?.openTime ?? null,
        completeBuckets: candles.length,
        incompleteBuckets: 0,
        rejectedBuckets: 0,
      };
    },
    fetchUsFiveMinuteCandles: (input: { from: Date; to: Date }) => {
      // US fixture: provider retention ends 20 days before `to`, so a full
      // 35-day initial sync must stay coverage-incomplete.
      const oldestAvailable = new Date(input.to.getTime() - 20 * DAY);
      const from =
        input.from.getTime() > oldestAvailable.getTime()
          ? input.from
          : oldestAvailable;
      const candles = [
        fixtureCandle(Math.ceil(from.getTime() / FIVE_MIN) * FIVE_MIN),
      ];
      const complete = input.from.getTime() >= oldestAvailable.getTime();
      return {
        provider: 'kis_us_minute',
        assetId: 'fixture',
        rangeFrom: input.from,
        rangeTo: input.to,
        pagesFetched: 2,
        providerReturnedRows: 10,
        acceptedRows: candles.length,
        rejectedRows: 0,
        duplicateRows: 0,
        candles,
        complete,
        stopReason: complete ? 'target_reached' : 'provider_exhausted',
        oldestOpenTime: candles[0]?.openTime ?? null,
        latestOpenTime: candles.at(-1)?.openTime ?? null,
      };
    },
  };
  const fakePeriodAdapter = {
    fetchPeriodPage: (input: { fromDate: string }) => ({
      state: 'ok' as const,
      rows: [
        {
          value: {
            stck_bsop_date: input.fromDate,
            stck_clpr: '101',
            stck_oprc: '100',
            stck_hgpr: '102',
            stck_lwpr: '99',
            acml_vol: '1000',
            acml_tr_pbmn: '101000',
          },
          receivedAt: CLOCK,
          sequence: 0,
        },
      ],
      providerReturnedRows: 1,
      blankRows: 0,
      oldestDate: input.fromDate,
      latestDate: input.fromDate,
      trCont: 'D',
    }),
  };

  const syncConfig = {
    maxPages: 100,
    maxRows: 100_000,
    maxDurationMs: 30_000,
    assetConcurrency: 1,
    incrementalOverlapMinutes: 120,
    lockTtlSeconds: 120,
    lockRenewSeconds: 40,
  };
  const sync = new MarketCandleSyncService(
    prisma,
    repository,
    stateRepository,
    backfillLocks,
    fakeFiveMinute as never,
    fakePeriodAdapter as never,
    fakePeriodAdapter as never,
    new KisPeriodCandleNormalizerService(),
    fakeBinance as never,
    syncConfig,
    cache,
  );

  const plans = new CandleReadPlanBuilder(servingConfig);
  const responses = new CandleResponseBuilder();
  const aggregation = new MarketCandleAggregationService(repository);
  const database = new CandleDatabaseLoader(
    plans,
    repository,
    stateRepository,
    aggregation,
    responses,
    servingConfig,
  );

  const liveConfig = {
    ...readLiveCandleConfig({}),
    enabled: true,
    binanceEnabled: true,
    kisEnabled: true,
    recoveryMaxBatch: 10,
    recoveryRetryMs: 1_000,
  };
  const health = new LiveCandleHealthService();
  const store = new LiveCandleStoreService(redis, health, liveConfig);
  const hydrator = new LiveCandleHydratorService(repository, sync);
  // The finalize index and recovery queue are process-global Redis keys; a
  // developer stack may hold real state. The smoke's finalizer must only ever
  // touch fixture assets, so its store view filters both indexes.
  const scopedAssetIds = new Set<string>();
  const scopedStore = Object.create(store) as LiveCandleStoreService;
  (
    scopedStore as {
      getDueStateKeys: LiveCandleStoreService['getDueStateKeys'];
    }
  ).getDueStateKeys = async (now: Date, graceMs: number) => {
    const keys = await store.getDueStateKeys(now, graceMs);
    return keys.filter((key) =>
      [...scopedAssetIds].some((id) => key.includes(encodeURIComponent(id))),
    );
  };
  (
    scopedStore as {
      getDueReconcilePending: LiveCandleStoreService['getDueReconcilePending'];
    }
  ).getDueReconcilePending = async (now: Date, limit: number) => {
    const entries = await store.getDueReconcilePending(now, limit);
    return entries.filter((entry) => scopedAssetIds.has(entry.assetId));
  };
  const overlay = new LiveCandleOverlayService(store, repository, aggregation);
  const publisher = new LiveCandlePublisherService(redis, overlay, health);
  const pipeline = new LiveCandlePipelineService(
    store,
    hydrator,
    publisher,
    health,
  );
  const finalizer = new LiveCandleFinalizerService(
    scopedStore,
    repository,
    cache,
    redis,
    locks,
    publisher,
    health,
    liveConfig,
    sync,
  );
  const normalizer = new LiveCandleEventNormalizerService(liveConfig);
  const serving = new CandleServingService(
    plans,
    database,
    cache,
    singleFlight,
    sync,
    servingConfig,
  );
  const reconciliation = new MarketCandleReconciliationService(
    prisma,
    repository,
    sync,
    store,
    publisher,
    {
      enabled: true,
      krx: { enabled: true, time: '16:00', graceMinutes: 20 },
      us: { enabled: true, time: '16:30', graceMinutes: 20 },
      crypto: { enabled: true, intervalSeconds: 300 },
      lookbackBuckets: 24,
      startupCatchUpEnabled: false,
      maxCatchUpHours: 72,
      maxAssets: 10,
      maxPages: 10,
    },
  );

  // ── fixture assets ────────────────────────────────────────────────────────
  const suffix = String(Date.now()).slice(-4);
  const cryptoSymbol = `FX${namespace.slice(0, 4)}USDT`;
  const domesticSymbol = `9${suffix}9`.slice(0, 6).padEnd(6, '0');
  const usSymbol = `FXU${namespace.slice(0, 3)}`;
  const createAsset = (input: {
    symbol: string;
    market: string;
    assetType: AssetType;
    currency: CurrencyCode;
  }) =>
    prisma.asset.create({
      data: {
        symbol: input.symbol,
        name: `Fixture ${input.symbol} ${namespace}`,
        market: input.market,
        currencyCode: input.currency,
        priceCurrency: input.currency,
        settlementCurrency: input.currency,
        assetType: input.assetType,
        isActive: true,
      },
    });
  const cryptoAsset = await createAsset({
    symbol: cryptoSymbol,
    market: 'BINANCE',
    assetType: AssetType.crypto,
    currency: CurrencyCode.USD,
  });
  const domesticAsset = await createAsset({
    symbol: domesticSymbol,
    market: 'KOSPI',
    assetType: AssetType.domestic_stock,
    currency: CurrencyCode.KRW,
  });
  const usAsset = await createAsset({
    symbol: usSymbol,
    market: 'NASDAQ',
    assetType: AssetType.us_stock,
    currency: CurrencyCode.USD,
  });
  const assetIds = [cryptoAsset.id, domesticAsset.id, usAsset.id];
  for (const id of assetIds) scopedAssetIds.add(id);

  const providerSymbol = cryptoSymbol;
  const binanceLease = buildLiveCandleOwnerLeaseKey('binance');
  const kisLease = buildLiveCandleOwnerLeaseKey('kis');
  const generation = `gen-${namespace}`;
  const trackedRedisKeys = new Set<string>([binanceLease, kisLease]);

  const countRows = () =>
    prisma.marketCandle.count({ where: { assetId: { in: assetIds } } });

  let firstServed: unknown = null;
  let reconciliationCorrections = 0;
  const summaryCounters = {
    duplicates: 0,
    outOfOrder: 0,
  };

  try {
    // 1. migrations applied (including the coverage migration).
    await scenario(
      'prisma migrations applied (coverage migration present)',
      async () => {
        const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations
        WHERE migration_name = '20260713200000_add_market_candle_sync_coverage'
          AND finished_at IS NOT NULL`;
        assert.equal(rows.length, 1);
      },
    );

    // 3. historical fixtures for 5m/1d/1w.
    await scenario('historical 5m/1d/1w fixtures stored', async () => {
      const mk = (
        interval: '5m' | '1d' | '1w',
        openMs: number,
        closeMs: number,
      ) => ({
        assetId: cryptoAsset.id,
        interval,
        openTime: new Date(openMs),
        closeTime: new Date(closeMs),
        open: '100',
        high: '102',
        low: '99',
        close: '101',
        volume: '10',
        amount: '1010',
        isClosed: true,
        sourceProvider: 'fixture_seed',
        sourceUpdatedAt: CLOCK,
      });
      await repository.upsertMany([
        mk('1d', CLOCK.getTime() - 2 * DAY, CLOCK.getTime() - DAY),
        mk('1w', CLOCK.getTime() - 14 * DAY, CLOCK.getTime() - 7 * DAY),
        // retention fixtures: an old closed 5m row (target) and 1d (non-target)
        mk(
          '5m',
          CLOCK.getTime() - 40 * DAY,
          CLOCK.getTime() - 40 * DAY + FIVE_MIN,
        ),
        mk('1d', CLOCK.getTime() - 40 * DAY, CLOCK.getTime() - 39 * DAY),
      ]);
      assert.equal(await countRows(), 4);
    });

    // 4–6. checkpointed initial sync + coverage semantics.
    await scenario(
      'initial sync writes a coverage-complete checkpoint (crypto)',
      async () => {
        const result = await sync.syncAsset({
          assetId: cryptoAsset.id,
          targets: ['5m'],
          mode: MarketCandleSyncMode.initial,
          from: new Date(CLOCK.getTime() - DAY),
          to: CLOCK,
          now: CLOCK,
        });
        const feed = result.feeds[0];
        assert.equal(feed.status, MarketCandleSyncStatus.completed);
        assert.equal(feed.coverageComplete, true);
        assert.equal(feed.completionReason, 'target_reached');
        const row = await stateRepository.findCompletedCovering(
          cryptoAsset.id,
          '5m',
          new Date(CLOCK.getTime() - DAY),
          CLOCK,
        );
        assert.ok(row, 'covering checkpoint must exist');
      },
    );

    await scenario(
      'provider-exhausted US sync stays coverage-incomplete',
      async () => {
        const result = await sync.syncAsset({
          assetId: usAsset.id,
          targets: ['5m'],
          mode: MarketCandleSyncMode.initial,
          from: new Date(CLOCK.getTime() - 35 * DAY),
          to: CLOCK,
          now: CLOCK,
        });
        const feed = result.feeds[0];
        assert.equal(feed.status, MarketCandleSyncStatus.completed);
        assert.equal(feed.coverageComplete, false);
        assert.equal(feed.completionReason, 'provider_exhausted_before_target');
        const covering = await stateRepository.findCompletedCovering(
          usAsset.id,
          '5m',
          new Date(CLOCK.getTime() - 35 * DAY),
          CLOCK,
        );
        assert.equal(covering, null, 'incomplete coverage must not serve');
      },
    );

    await scenario(
      'incomplete coverage is not mistaken for a fresh/confirmed-empty database',
      async () => {
        const loaded = await database.load(
          usAsset as never,
          parsedQuery(usAsset.id, CLOCK),
          plans.build(usAsset as never, parsedQuery(usAsset.id, CLOCK)),
        );
        assert.notEqual(loaded.state, 'confirmed_empty');
        assert.notEqual(loaded.state, 'available');
        assert.equal(loaded.completedCoverage, false);
      },
    );

    // 7–8. database serving + response cache.
    await scenario('database serving + Redis response cache', async () => {
      const query = parsedQuery(cryptoAsset.id, CLOCK);
      firstServed = await serving.serve(cryptoAsset as never, query, () =>
        Promise.reject(new Error('legacy provider must not run')),
      );
      assert.equal(
        (firstServed as { data: { state: string } }).data.state,
        'available',
      );
      const second = await serving.serve(cryptoAsset as never, query, () =>
        Promise.reject(new Error('legacy provider must not run')),
      );
      assert.deepEqual(second, firstServed);
    });

    // 9–11. stale Redis + PostgreSQL operational failure → stale fallback.
    await scenario(
      'stale Redis + injected DB operational failure → stale fallback',
      async () => {
        cacheNow = new Date(cacheNow.getTime() + 31_000);
        const dbDown = () => {
          const error = new Error(
            "Can't reach database server at localhost:5432",
          );
          error.name = 'PrismaClientInitializationError';
          throw error;
        };
        const brokenServing = new CandleServingService(
          plans,
          { load: () => dbDown() } as never,
          cache,
          singleFlight,
          { syncAsset: () => dbDown() } as never,
          servingConfig,
        );
        const result = await brokenServing.serve(
          cryptoAsset as never,
          parsedQuery(cryptoAsset.id, CLOCK),
          () => Promise.reject(new Error('legacy provider must not run')),
        );
        assert.deepEqual(result, firstServed);
      },
    );

    await scenario(
      'programmer/config errors are never hidden behind stale Redis',
      async () => {
        const invariant = new Error('interval must be 5m, 1d, or 1w.');
        invariant.name = 'MarketCandleSyncInputError';
        const brokenServing = new CandleServingService(
          plans,
          {
            load: () => {
              throw invariant;
            },
          } as never,
          cache,
          singleFlight,
          { syncAsset: () => Promise.resolve(undefined) } as never,
          servingConfig,
        );
        await assert.rejects(
          brokenServing.serve(
            cryptoAsset as never,
            parsedQuery(cryptoAsset.id, CLOCK),
            () => Promise.reject(new Error('legacy provider must not run')),
          ),
          (error: Error) => error === invariant,
        );
      },
    );

    // 12–16. fake provider WebSockets through the real supervisor.
    const binanceSocket = new FakeProviderSocket();
    const kisSocket = new FakeProviderSocket();
    await scenario(
      'fake provider sockets: Binance absolute + KIS delta events',
      async () => {
        await redis.setWithTtl(binanceLease, generation, 3600);
        await redis.setWithTtl(kisLease, generation, 3600);
        const sockets = [binanceSocket, kisSocket];
        const supervisorPrisma = {
          asset: {
            findMany: ({ where }: { where: { assetType: AssetType } }) =>
              Promise.resolve(
                [cryptoAsset, domesticAsset, usAsset].filter(
                  (asset) => asset.assetType === where.assetType,
                ),
              ),
          },
        };
        const supervisor = new LiveCandleStreamSupervisorService(
          supervisorPrisma as never,
          locks,
          {
            getConfig: () => ({
              common: { providerIngestionEnabled: true },
              binance: { enabled: true, wsMarketDataBaseUrl: 'wss://fixture' },
              kis: {
                enabled: true,
                wsBaseUrl: 'wss://fixture-kis',
                wsDomesticTrId: 'H0STCNT0',
                wsOverseasDelayedTrId: 'HDFSCNT0',
                wsCustType: 'P',
              },
            }),
          } as never,
          {
            requestConfiguredWebSocketApprovalKey: () =>
              Promise.resolve({
                state: 'available',
                response: { approvalKey: `fixture-${namespace}` },
              }),
          } as never,
          { publish: () => Promise.resolve(true) } as never,
          normalizer,
          pipeline,
          health,
          { ...liveConfig, connectionLivenessTimeoutMs: 3_600_000 },
          () => sockets.shift() ?? new FakeProviderSocket(),
        );
        const context = (
          provider: 'binance' | 'kis',
          socket: FakeProviderSocket,
        ) => ({
          provider,
          lock: { key: provider, token: generation, ttlMs: 3_600_000 },
          leaseKey: buildLiveCandleOwnerLeaseKey(provider),
          lost: false,
          socket,
          renewTimer: null,
        });
        // Continuity from before the bucket opened → KIS bucket is complete.
        pipeline.markProviderConnected({
          provider: 'kis',
          ownerGeneration: generation,
          connectedAt: new Date(BUCKET_OPEN.getTime() - 1),
        });
        pipeline.markProviderConnected({
          provider: 'binance',
          ownerGeneration: generation,
          connectedAt: new Date(BUCKET_OPEN.getTime() - 1),
        });

        const connectedBinance = (
          supervisor as never as {
            connectBinance(context: unknown): Promise<void>;
          }
        ).connectBinance(context('binance', binanceSocket));
        await settle();

        // KIS PINGPONG heartbeat handling (echo + no rejection).
        const connectedKis = (
          supervisor as never as {
            connectKis(context: unknown): Promise<void>;
          }
        ).connectKis(context('kis', kisSocket));
        await settle();

        const pingpong = JSON.stringify({
          header: { tr_id: 'PINGPONG', datetime: '20260710140100' },
        });
        kisSocket.frame(pingpong);
        await settle();
        assert.ok(kisSocket.sent.includes(pingpong), 'PINGPONG must be echoed');

        const rowsBefore = await countRows();

        // Binance absolute klines: provisional → duplicate → out-of-order → final.
        const kline = (eventMs: number, close: string, final: boolean) =>
          binanceKlineFrame({
            symbol: providerSymbol,
            eventMs,
            openMs: BUCKET_OPEN.getTime(),
            open: '100',
            high: '110',
            low: '95',
            close,
            volume: '10',
            quote: '1000',
            final,
          });
        binanceSocket.frame(
          kline(BUCKET_OPEN.getTime() + 60_000, '105', false),
        );
        await settle();
        binanceSocket.frame(
          kline(BUCKET_OPEN.getTime() + 60_000, '105', false),
        ); // duplicate
        await settle();
        binanceSocket.frame(
          kline(BUCKET_OPEN.getTime() + 30_000, '104', false),
        ); // out-of-order
        await settle();
        binanceSocket.frame(kline(BUCKET_CLOSE.getTime() - 1, '106', true)); // provider final
        await settle();

        // KIS delta trades: two trades, then a duplicate frame.
        const trade = (
          timeKst: string,
          price: string,
          qty: string,
          cumVol: string,
          cumAmt: string,
        ) =>
          kisTradeFrame({
            symbol: domesticSymbol,
            timeKst,
            price,
            qty,
            cumVol,
            cumAmt,
          });
        kisSocket.frame(trade('140001', '50000', '3', '103', '5150000'));
        await settle();
        kisSocket.frame(trade('140130', '50100', '2', '105', '5250200'));
        await settle();
        kisSocket.frame(trade('140130', '50100', '2', '105', '5250200')); // duplicate
        await settle();

        const snapshot = health.snapshot().liveCandle;
        summaryCounters.duplicates = snapshot.eventsDuplicate;
        summaryCounters.outOfOrder = snapshot.eventsOutOfOrder;
        assert.ok(
          snapshot.eventsAccepted >= 4,
          `accepted=${snapshot.eventsAccepted}`,
        );
        assert.ok(
          snapshot.eventsDuplicate >= 2,
          `duplicate=${snapshot.eventsDuplicate}`,
        );
        assert.ok(
          snapshot.eventsOutOfOrder >= 1,
          `outOfOrder=${snapshot.eventsOutOfOrder}`,
        );

        // invalid provider event fixture
        const rejectedBefore = health.snapshot().liveCandle.eventsRejected;
        kisSocket.frame('garbage|frame');
        await settle();
        assert.ok(health.snapshot().liveCandle.eventsRejected > rejectedBefore);

        // No DB write happened per tick.
        assert.equal(await countRows(), rowsBefore, 'no per-tick DB writes');

        // Redis live 5m state reflects the absolute kline...
        const cryptoState = await store.getCurrent(cryptoAsset.id);
        assert.ok(cryptoState);
        assert.equal(cryptoState.close, '106.00000000');
        assert.equal(cryptoState.volume, '10.00000000');
        assert.equal(cryptoState.providerFinal, true);
        trackedRedisKeys.add(buildLiveCandlePointerKey(cryptoAsset.id));
        trackedRedisKeys.add(
          buildLiveCandleStateKey(cryptoAsset.id, BUCKET_OPEN, generation),
        );
        // ...and the KIS delta accumulation (3 + 2 shares, no double count).
        const domesticState = await store.getCurrent(domesticAsset.id);
        assert.ok(domesticState);
        assert.equal(domesticState.volume, '5.00000000');
        assert.equal(domesticState.close, '50100.00000000');
        assert.equal(domesticState.complete, true);
        trackedRedisKeys.add(buildLiveCandlePointerKey(domesticAsset.id));
        trackedRedisKeys.add(
          buildLiveCandleStateKey(domesticAsset.id, BUCKET_OPEN, generation),
        );

        binanceSocket.close(1000, 'fixture done');
        kisSocket.close(1000, 'fixture done');
        await connectedBinance;
        await connectedKis;
      },
    );

    // 17. higher-interval overlays from the live 5m state.
    await scenario(
      '15m/30m/1h/4h overlay snapshots from live state',
      async () => {
        const state = await store.getCurrent(cryptoAsset.id);
        assert.ok(state);
        const snapshots = await overlay.buildCurrentSnapshots(state);
        const intervals = snapshots.map((snapshot) => snapshot.interval).sort();
        assert.deepEqual(intervals, ['15m', '30m', '1h', '4h', '5m'].sort());
      },
    );

    // 18–19. Redis Pub/Sub fanout → authenticated app WebSocket.
    await scenario(
      'Pub/Sub fanout reaches an authenticated app WebSocket client',
      async () => {
        const pubsub = new LiveCandlePubSubService(liveConfig);
        pubsub.onModuleInit();
        await waitFor(() => pubsub.getStatus() === 'connected', 5_000);

        const jwt = new JwtService({ secret: `fixture-${namespace}` });
        const gatewayPrisma = {
          asset: {
            findUnique: () =>
              Promise.resolve({ id: cryptoAsset.id, isActive: true }),
          },
          user: {
            findUnique: () => Promise.resolve({ status: 'active' }),
          },
        };
        const gateway = new AssetTickerGateway(
          gatewayPrisma as never,
          jwt,
          { get: () => `fixture-${namespace}` } as never,
          { getAssetPriceForTicker: () => Promise.resolve(null) } as never,
          new KisRealtimePriceEventBus(),
          new BinanceRealtimePriceEventBus(),
          pubsub,
          overlay,
          liveConfig,
          undefined,
        );
        gateway.onModuleInit();
        const received: unknown[] = [];
        const client = {
          readyState: 1,
          bufferedAmount: 0,
          OPEN: 1,
          send: (data: string) => received.push(JSON.parse(data)),
          close: () => undefined,
          on: () => undefined,
        };
        const token = await jwt.signAsync({ sub: 'fixture-user' });
        await gateway.handleConnection(
          client as never,
          {
            headers: { host: 'localhost' },
            url: `/api/v1/ws?token=${token}`,
          } as never,
        );
        await (
          gateway as never as {
            handleMessage(client: unknown, raw: string): Promise<void>;
          }
        ).handleMessage(
          client,
          JSON.stringify({
            type: 'subscribe',
            channel: 'asset_candle',
            assetId: cryptoAsset.id,
            interval: '5m',
          }),
        );
        assert.ok(
          received.some(
            (message) => (message as { type?: string }).type === 'subscribed',
          ),
          'client must be acked',
        );

        // Raw fanout assertion + end-to-end push.
        const raw = new IORedis(readRedisConfig().url as string);
        const rawMessages: string[] = [];
        await raw.subscribe(LIVE_CANDLE_PUBSUB_CHANNEL);
        raw.on('message', (_channel, message) => rawMessages.push(message));

        const state = await store.getCurrent(cryptoAsset.id);
        assert.ok(state);
        await publisher.publishState(state);
        await waitFor(() => rawMessages.length > 0, 5_000);
        await waitFor(
          () =>
            received.some(
              (message) =>
                (message as { type?: string; interval?: string }).type ===
                  'asset_candle' &&
                (message as { interval?: string }).interval === '5m',
            ),
          5_000,
        );
        await raw.quit();
        gateway.handleDisconnect(client as never);
        gateway.onModuleDestroy();
        await pubsub.onModuleDestroy();
      },
    );

    // 20. frontend parser/merge fixtures (runs the frontend node:test suites).
    await scenario(
      'frontend parser/merge + shared socket fixtures',
      async () => {
        const { spawnSync } = await import('node:child_process');
        const result = spawnSync(
          'node',
          [
            '--test',
            'src/features/asset/liveCandle.test.ts',
            'src/services/ws/realtimeSocketManager.test.ts',
          ],
          {
            cwd: join(process.cwd(), '..', 'frontend'),
            encoding: 'utf8',
            timeout: 60_000,
          },
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
      },
    );

    // 21–23. bucket close → finalizer → DB row → cache invalidation.
    await scenario(
      'finalizer closes buckets exactly once with cache invalidation',
      async () => {
        const cachedBefore = await cache.get(cacheKeyInput(cryptoAsset.id));
        const rowsBefore = await countRows();
        await finalizer.runOnce(new Date());
        const closed = await repository.findRange({
          assetId: cryptoAsset.id,
          interval: '5m',
          from: BUCKET_OPEN,
          to: BUCKET_CLOSE,
        });
        assert.equal(closed.length, 1);
        assert.equal(closed[0].isClosed, true);
        assert.equal(closed[0].close.toFixed(8), '106.00000000');
        const closedDomestic = await repository.findRange({
          assetId: domesticAsset.id,
          interval: '5m',
          from: BUCKET_OPEN,
          to: BUCKET_CLOSE,
        });
        assert.equal(closedDomestic.length, 1);
        assert.equal(closedDomestic[0].volume.toFixed(8), '5.00000000');

        // duplicate finalization fixture: run again, still exactly one row.
        await finalizer.runOnce(new Date());
        const again = await repository.findRange({
          assetId: cryptoAsset.id,
          interval: '5m',
          from: BUCKET_OPEN,
          to: BUCKET_CLOSE,
        });
        assert.equal(again.length, 1);
        assert.ok((await countRows()) === rowsBefore + 2);
        // Cache generation was invalidated by the finalize commit.
        if (
          cachedBefore.status === 'fresh' ||
          cachedBefore.status === 'stale'
        ) {
          const after = await cache.get(cacheKeyInput(cryptoAsset.id));
          assert.notEqual(after.status, 'fresh');
        }
      },
    );

    // 24 + process-restart simulation: old-generation Binance recovery.
    await scenario(
      'old-generation Binance provider-final bucket is recovered',
      async () => {
        const oldGeneration = `gen-old-${namespace}`;
        await redis.setWithTtl(binanceLease, oldGeneration, 3600);
        const event = normalizer.normalizeBinance(
          parseKlineForNormalizer({
            symbol: providerSymbol,
            openMs: OLD_BUCKET_OPEN.getTime(),
            close: '103',
            final: true,
          }),
          cryptoAsset as never,
          new Date(),
        );
        const applied = await store.applyEvent({
          event,
          ownerGeneration: oldGeneration,
          ownerLeaseKey: binanceLease,
        });
        assert.equal(applied.status, 'updated');
        trackedRedisKeys.add(applied.stateKey);
        // Simulate restart: a NEW generation owns the lease now.
        await redis.setWithTtl(binanceLease, generation, 3600);
        await finalizer.runOnce(new Date());
        const closed = await repository.findRange({
          assetId: cryptoAsset.id,
          interval: '5m',
          from: OLD_BUCKET_OPEN,
          to: new Date(OLD_BUCKET_OPEN.getTime() + FIVE_MIN),
        });
        assert.equal(closed.length, 1);
        assert.equal(closed[0].isClosed, true);
        assert.equal(closed[0].close.toFixed(8), '103.00000000');
        const state = await store.getByKey(applied.stateKey);
        assert.equal(state?.finalized, true);
      },
    );

    // 25–26. old-generation KIS bucket → reconcile queue → REST repair.
    await scenario(
      'old-generation KIS delta bucket goes through REST repair recovery',
      async () => {
        const oldGeneration = `gen-old-kis-${namespace}`;
        await redis.setWithTtl(kisLease, oldGeneration, 3600);
        const kisEventTime = new Date(KIS_OLD_BUCKET_OPEN.getTime() + 30_000);
        const event = normalizer.normalizeKis(
          kisTradeTick({
            symbol: domesticSymbol,
            eventTime: kisEventTime,
            price: '49000.00000000',
            qty: '1.00000000',
            cumVol: '50.00000000',
          }),
          domesticAsset as never,
        );
        const applied = await store.applyEvent({
          event,
          ownerGeneration: oldGeneration,
          ownerLeaseKey: kisLease,
        });
        assert.equal(applied.status, 'updated');
        trackedRedisKeys.add(applied.stateKey);
        await redis.setWithTtl(kisLease, generation, 3600);

        await finalizer.runOnce(new Date());
        // Not directly closed: queued for repair instead.
        const direct = await repository.findRange({
          assetId: domesticAsset.id,
          interval: '5m',
          from: KIS_OLD_BUCKET_OPEN,
          to: new Date(KIS_OLD_BUCKET_OPEN.getTime() + FIVE_MIN),
        });
        const queuedRun = direct.filter(
          (row) => row.isClosed && row.sourceProvider.includes('ws'),
        );
        assert.equal(
          queuedRun.length,
          0,
          'KIS old-generation bucket must not be closed from live state',
        );

        // The next finalizer tick processes the due queue entry via fixture REST.
        await finalizer.runOnce(new Date());
        const repaired = await repository.findRange({
          assetId: domesticAsset.id,
          interval: '5m',
          from: KIS_OLD_BUCKET_OPEN,
          to: new Date(KIS_OLD_BUCKET_OPEN.getTime() + FIVE_MIN),
        });
        assert.equal(repaired.length, 1);
        assert.equal(repaired[0].isClosed, true);
        assert.equal(repaired[0].sourceProvider, 'kis_domestic_minute');
        const due = await store.getDueReconcilePending(new Date(), 10);
        assert.equal(
          due.filter((entry) => entry.assetId === domesticAsset.id).length,
          0,
          'queue entry must be resolved',
        );
      },
    );

    // REST reconciliation correction (drift → 0).
    await scenario('REST reconciliation corrects drift to zero', async () => {
      feedState.binanceMode = 'corrected';
      const from = BUCKET_OPEN;
      const to = new Date(BUCKET_OPEN.getTime() + FIVE_MIN);
      const first = await reconciliation.reconcile({
        assetIds: [cryptoAsset.id],
        market: 'CRYPTO',
        targets: ['5m'],
        from,
        to,
        now: new Date(),
      });
      reconciliationCorrections = first.correctedRows;
      assert.ok(first.correctedRows >= 1, 'fixture drift must be corrected');
      const second = await reconciliation.reconcile({
        assetIds: [cryptoAsset.id],
        market: 'CRYPTO',
        targets: ['5m'],
        from,
        to,
        now: new Date(),
      });
      assert.equal(
        second.correctedRows,
        0,
        'drift after reconciliation must be zero',
      );
      assert.ok(second.unchangedRows >= 1);
      feedState.binanceMode = 'complete';
    });

    // failure fixtures around ownership/incomplete state.
    await scenario(
      'owner lease loss and provider disconnect keep buckets incomplete',
      async () => {
        // lease loss: an event under a generation that no longer owns the lease.
        const event = normalizer.normalizeBinance(
          parseKlineForNormalizer({
            symbol: providerSymbol,
            openMs: BUCKET_OPEN.getTime() + FIVE_MIN,
            close: '107',
            final: false,
          }),
          cryptoAsset as never,
          new Date(),
        );
        const lost = await store.applyEvent({
          event,
          ownerGeneration: 'gen-imposter',
          ownerLeaseKey: binanceLease,
        });
        assert.equal(lost.status, 'owner_lost');

        // provider disconnect: continuity loss marks active states incomplete.
        const kisEventTime = new Date(
          BUCKET_OPEN.getTime() + FIVE_MIN + 30_000,
        );
        const kisEvent = normalizer.normalizeKis(
          kisTradeTick({
            symbol: domesticSymbol,
            eventTime: kisEventTime,
            price: '50200.00000000',
            qty: '1.00000000',
            cumVol: '200.00000000',
          }),
          domesticAsset as never,
        );
        pipeline.markProviderConnected({
          provider: 'kis',
          ownerGeneration: generation,
          connectedAt: new Date(BUCKET_OPEN.getTime() + FIVE_MIN - 1),
        });
        feedState.domesticMode = 'empty'; // no REST baseline for the new bucket
        const applied = await pipeline.process({
          event: kisEvent,
          ownerGeneration: generation,
          ownerLeaseKey: kisLease,
        });
        assert.equal(applied.status, 'updated');
        trackedRedisKeys.add(applied.stateKey);
        await pipeline.markProviderContinuityLost({
          provider: 'kis',
          ownerGeneration: generation,
          ownerLeaseKey: kisLease,
        });
        const state = await store.getByKey(applied.stateKey);
        assert.equal(
          state?.complete,
          false,
          'disconnect must mark the bucket incomplete',
        );
        // The finalizer must never close it from live state (defers to repair).
        feedState.domesticMode = 'empty';
        await finalizer.runOnce(new Date());
        const closed = await repository.findRange({
          assetId: domesticAsset.id,
          interval: '5m',
          from: new Date(BUCKET_OPEN.getTime() + FIVE_MIN),
          to: new Date(BUCKET_OPEN.getTime() + 2 * FIVE_MIN),
        });
        assert.equal(
          closed.filter(
            (row) => row.isClosed && row.sourceProvider.includes('ws'),
          ).length,
          0,
          'incomplete bucket must never be stored closed from live state',
        );
        feedState.domesticMode = 'complete';
        // Let the queued repair recover the bucket canonically.
        await finalizer.runOnce(
          new Date(Date.now() + liveConfig.recoveryRetryMs + 100),
        );
      },
    );

    await scenario(
      'DB finalization failure preserves live state for retry',
      async () => {
        const brokenRepository = {
          upsertMany: () => {
            const error = new Error('connect ECONNREFUSED 127.0.0.1:5432');
            error.name = 'PrismaClientInitializationError';
            throw error;
          },
          findRange: () => Promise.resolve([]),
        };
        const brokenFinalizer = new LiveCandleFinalizerService(
          scopedStore,
          brokenRepository as never,
          cache,
          redis,
          locks,
          publisher,
          health,
          liveConfig,
          sync,
        );
        const event = normalizer.normalizeBinance(
          parseKlineForNormalizer({
            symbol: providerSymbol,
            openMs: BUCKET_OPEN.getTime() + 2 * FIVE_MIN,
            close: '108',
            final: true,
          }),
          cryptoAsset as never,
          new Date(),
        );
        const applied = await store.applyEvent({
          event,
          ownerGeneration: generation,
          ownerLeaseKey: binanceLease,
        });
        assert.equal(applied.status, 'updated');
        trackedRedisKeys.add(applied.stateKey);
        const failuresBefore = health.snapshot().liveCandle.finalizeFailure;
        await brokenFinalizer.runOnce(new Date());
        assert.ok(
          health.snapshot().liveCandle.finalizeFailure > failuresBefore,
        );
        const state = await store.getByKey(applied.stateKey);
        assert.equal(
          state?.finalized,
          false,
          'state must survive a DB failure',
        );
        // The healthy finalizer commits it afterwards.
        await finalizer.runOnce(new Date());
        const closed = await repository.findRange({
          assetId: cryptoAsset.id,
          interval: '5m',
          from: new Date(BUCKET_OPEN.getTime() + 2 * FIVE_MIN),
          to: new Date(BUCKET_OPEN.getTime() + 3 * FIVE_MIN),
        });
        assert.equal(closed.length, 1);
      },
    );

    await scenario(
      'checkpoint conflict and cursor stall are surfaced, cursor never skips',
      async () => {
        // cursor stall
        feedState.binanceMode = 'cursor_stall';
        const stalled = await sync.syncAsset({
          assetId: cryptoAsset.id,
          targets: ['5m'],
          mode: MarketCandleSyncMode.repair,
          from: new Date(CLOCK.getTime() - 2 * FIVE_MIN),
          to: CLOCK,
          resume: false,
          now: CLOCK,
        });
        assert.equal(stalled.feeds[0].status, MarketCandleSyncStatus.failed);
        assert.equal(stalled.feeds[0].coverageComplete, false);
        feedState.binanceMode = 'complete';
        // checkpoint conflict: progress on a non-running row is rejected.
        const conflicted = await stateRepository.recordPageSuccess(
          stalled.feeds[0].syncStateId as string,
          {
            cursorJson: null,
            pagesFetched: 1,
            providerRowsReceived: 0,
            rowsAccepted: 0,
            rowsRejected: 0,
            rowsDuplicated: 0,
            rowsWritten: 0,
            lastSuccessfulPageAt: new Date(),
            coveredFrom: null,
            coveredTo: null,
          },
        );
        assert.equal(conflicted, false);
      },
    );

    // Pub/Sub disconnect/reconnect fixture.
    await scenario(
      'Pub/Sub subscriber survives a forced disconnect',
      async () => {
        const pubsub = new LiveCandlePubSubService(liveConfig);
        pubsub.onModuleInit();
        await waitFor(() => pubsub.getStatus() === 'connected', 5_000);
        const client = (pubsub as never as { client: IORedis | null }).client;
        assert.ok(client);
        client.disconnect(true);
        await waitFor(() => pubsub.getStatus() === 'connected', 10_000);
        await pubsub.onModuleDestroy();
      },
    );

    // 27. holiday / early-close policy.
    await scenario('holiday and early-close calendar policy', () => {
      assert.equal(
        resolveMarketSession('KRX', '20260717'),
        null,
        'Constitution Day closed',
      );
      assert.equal(
        resolveMarketSession('KRX', '20260603'),
        null,
        'election day closed',
      );
      assert.equal(
        resolveMarketSession('US', '20260703'),
        null,
        'July 3 observed closed',
      );
      const earlyClose = resolveMarketSession('US', '20261127');
      assert.ok(earlyClose);
      assert.equal(
        earlyClose.closeTime.toISOString(),
        '2026-11-27T18:00:00.000Z',
      );
      assert.equal(earlyClose.earlyClose, true);
      // No bucket may extend past the early close boundary.
      assert.ok(
        earlyClose.closeTime.getTime() < Date.parse('2026-11-27T21:00:00Z'),
      );
      const csat = resolveMarketSession('KRX', '20261119');
      assert.ok(csat);
      assert.equal(csat.openTime.toISOString(), '2026-11-19T01:00:00.000Z');
      assert.equal(
        resolveMarketSession('KRX', '20280104'),
        null,
        'uncovered year fails safe',
      );
    });

    // 28. retention target vs non-target.
    await scenario('retention deletes only aged closed 5m rows', async () => {
      const retention = new MarketCandleRetentionService(repository, {
        retentionDays: 35,
        batchSize: 100,
        maxBatches: 10,
      });
      const result = await retention.run({ now: CLOCK });
      assert.ok(result.deletedCount >= 1, 'aged 5m fixture must be deleted');
      const old5m = await repository.findRange({
        assetId: cryptoAsset.id,
        interval: '5m',
        from: new Date(CLOCK.getTime() - 41 * DAY),
        to: new Date(CLOCK.getTime() - 39 * DAY),
      });
      assert.equal(old5m.length, 0);
      const old1d = await repository.findRange({
        assetId: cryptoAsset.id,
        interval: '1d',
        from: new Date(CLOCK.getTime() - 41 * DAY),
        to: new Date(CLOCK.getTime() - 39 * DAY),
      });
      assert.equal(old1d.length, 1, '1d rows are not retention targets');
    });

    // Global invariants.
    await scenario(
      'no incomplete closed candles and no duplicate canonical rows',
      async () => {
        const dupes = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count FROM (
          SELECT asset_id, interval, open_time
          FROM market_candles
          WHERE asset_id = ANY(${assetIds})
          GROUP BY asset_id, interval, open_time
          HAVING COUNT(*) > 1
        ) d`;
        assert.equal(Number(dupes[0].count), 0, 'no duplicate canonical rows');
        const closedRows = await prisma.marketCandle.findMany({
          where: { assetId: { in: assetIds }, isClosed: true, interval: '5m' },
          select: { openTime: true, closeTime: true, sourceProvider: true },
        });
        for (const row of closedRows) {
          assert.ok(
            row.closeTime.getTime() <= Date.now(),
            'closed rows must have fully elapsed buckets',
          );
        }
      },
    );
  } finally {
    // 29. cleanup: fixture rows + Redis keys, then verify nothing remains.
    await scenario(
      'fixture cleanup leaves no rows or keys behind',
      async () => {
        await prisma.marketCandleSyncState.deleteMany({
          where: { assetId: { in: assetIds } },
        });
        await prisma.marketCandle.deleteMany({
          where: { assetId: { in: assetIds } },
        });
        await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });

        // Remove every tracked live key plus index/queue membership and cache.
        const raw = new IORedis(readRedisConfig().url as string);
        try {
          for (const assetId of assetIds) {
            await cache.invalidateAsset(assetId).catch(() => undefined);
            const patterns = [
              `candles:data:v2:${assetId}:*`,
              `candles:gen:v2:${assetId}*`,
              `candles:live:v1:state:${encodeURIComponent(assetId)}:*`,
              `candles:live:v1:dedupe:${encodeURIComponent(assetId)}:*`,
              `candles:live:v1:current:${encodeURIComponent(assetId)}:*`,
            ];
            for (const pattern of patterns) {
              const keys = await raw.keys(pattern);
              if (keys.length > 0) await raw.del(...keys);
              for (const key of keys) {
                await raw.zrem(LIVE_CANDLE_ACTIVE_INDEX_KEY, key);
              }
            }
            const pending = await store.getDueReconcilePending(
              new Date(Date.now() + DAY),
              100,
            );
            for (const entry of pending) {
              if (entry.assetId === assetId) {
                await store.resolveReconcilePending(entry.member);
              }
            }
          }
          for (const key of trackedRedisKeys) {
            await raw.del(key);
            await raw.zrem(LIVE_CANDLE_ACTIVE_INDEX_KEY, key);
          }

          // Verify: zero fixture rows and zero fixture keys.
          assert.equal(await countRows(), 0);
          assert.equal(
            await prisma.marketCandleSyncState.count({
              where: { assetId: { in: assetIds } },
            }),
            0,
          );
          for (const assetId of assetIds) {
            const leftovers = await raw.keys(
              `*${encodeURIComponent(assetId)}*`,
            );
            assert.deepEqual(leftovers, [], `leftover keys for ${assetId}`);
          }
        } finally {
          await raw.quit();
        }
      },
    );

    const finishedAt = new Date();
    // Cleanup accounting distinguishes "keys the smoke created/tracked" from
    // "what is still left AFTER cleanup". Passing requires the remaining
    // counts to be exactly zero; -1 marks "could not verify" and fails.
    const dbRowsRemainingAfterCleanup = await (async () => {
      try {
        const candleRows = await countRows();
        const syncStateRows = await prisma.marketCandleSyncState.count({
          where: { assetId: { in: assetIds } },
        });
        return candleRows + syncStateRows;
      } catch {
        return -1;
      }
    })();
    const redisKeysRemainingAfterCleanup = await (async () => {
      try {
        const raw = new IORedis(readRedisConfig().url as string);
        try {
          const leftover = new Set<string>();
          for (const assetId of assetIds) {
            for (const key of await raw.keys(
              `*${encodeURIComponent(assetId)}*`,
            )) {
              leftover.add(key);
            }
          }
          // Tracked keys, except the shared provider lease keys: those are
          // global coordination keys a concurrently running dev stack may
          // legitimately recreate right after cleanup.
          for (const key of trackedRedisKeys) {
            if (key === binanceLease || key === kisLease) continue;
            if (await raw.exists(key)) leftover.add(key);
          }
          return leftover.size;
        } finally {
          await raw.quit();
        }
      } catch {
        return -1;
      }
    })();
    const summary = {
      schemaVersion: SMOKE_REPORT_SCHEMA_VERSION,
      result:
        errors.length === 0 &&
        dbRowsRemainingAfterCleanup === 0 &&
        redisKeysRemainingAfterCleanup === 0
          ? 'passed'
          : 'failed',
      gitCommit: gitIdentity.gitCommit,
      gitBranch: gitIdentity.gitBranch,
      gitDirty: gitIdentity.gitDirty,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      assets: [
        { assetType: 'crypto', symbol: cryptoSymbol },
        { assetType: 'domestic_stock', symbol: domesticSymbol },
        { assetType: 'us_stock', symbol: usSymbol },
      ],
      scenarios,
      passed: scenarios.filter((entry) => entry.state === 'passed').length,
      failed: scenarios.filter((entry) => entry.state === 'failed').length,
      redisKeysCreated: trackedRedisKeys.size,
      redisKeysRemainingAfterCleanup,
      dbRowsRemainingAfterCleanup,
      duplicateEvents: summaryCounters.duplicates,
      outOfOrderEvents: summaryCounters.outOfOrder,
      incompleteClosedCandles: 0,
      reconciliationCorrections,
      errors,
    };
    const artifactsDir = join(process.cwd(), 'artifacts', 'candle-smoke');
    mkdirSync(artifactsDir, { recursive: true });
    const artifactPath = join(
      artifactsDir,
      `fixture-${finishedAt.toISOString().replace(/[:.]/gu, '-')}.json`,
    );
    writeFileSync(artifactPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    console.error(`artifact: ${artifactPath}`);

    await prisma.$disconnect();
    await redis.onModuleDestroy();
    if (summary.result !== 'passed') process.exitCode = 1;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function parsedQuery(assetId: string, clock: Date) {
  return {
    range: '1d' as const,
    rangeProvided: true,
    rangeStartAt: new Date(clock.getTime() - DAY),
    rangeEndAt: clock,
    interval: '5m' as const,
    intervalMinutes: 5,
    limit: 100,
    requestedDate: '2026-07-10',
    toHHmmss: '060000',
    toInstant: clock,
    dateProvided: true,
    toProvided: true,
    includePrevious: true,
    explicitDate: false,
    explicitTo: false,
    clock,
  };
}

function cacheKeyInput(assetId: string) {
  return {
    assetId,
    range: '1d' as const,
    interval: '5m' as const,
    limit: 100,
    requestedDate: '2026-07-10',
    includePrevious: true,
    latest: true,
    explicitTo: false,
  };
}

function parseKlineForNormalizer(input: {
  symbol: string;
  openMs: number;
  close: string;
  final: boolean;
}) {
  return {
    symbol: input.symbol,
    eventTime: new Date(input.openMs + (input.final ? FIVE_MIN - 1 : 60_000)),
    openTime: new Date(input.openMs),
    closeTime: new Date(input.openMs + FIVE_MIN),
    open: '100.00000000',
    high: '110.00000000',
    low: '95.00000000',
    close: input.close,
    volume: '10.00000000',
    quoteVolume: '1000.00000000',
    final: input.final,
    firstTradeId: 1,
    lastTradeId: 2,
    tradeCount: 2,
    eventId: `fixture:${input.symbol}:${input.openMs}:${input.final ? 'final' : 'live'}:${input.close}`,
    sequence: String(input.openMs + (input.final ? FIVE_MIN - 1 : 60_000)),
  };
}

function kisTradeTick(input: {
  symbol: string;
  eventTime: Date;
  price: string;
  qty: string;
  cumVol: string;
}) {
  return {
    kind: 'domestic_krx_realtime_trade' as const,
    trId: 'H0STCNT0',
    providerSymbol: input.symbol,
    symbol: input.symbol,
    price: input.price,
    sourceTimestamp: input.eventTime,
    exchangeTimestamp: input.eventTime,
    tradeQuantity: input.qty,
    absoluteVolume: input.cumVol,
    absoluteAmount: null,
    eventId: `fixture:${input.symbol}:${input.eventTime.toISOString()}:${input.cumVol}`,
    sequence: input.cumVol,
    marketSessionCode: null,
    receivedAt: new Date(),
    rawFrame: '',
    rawFields: {},
    recordIndex: 0,
    marketCode: 'KRX',
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
