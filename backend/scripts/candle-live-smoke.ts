/**
 * Long-running REAL-provider candle smoke harness (not bound to Jest
 * timeouts). Talks to the actual Binance Spot WebSocket/REST or the actual
 * KIS WebSocket/REST using the credentials from the environment.
 *
 * Gates (all must hold, per provider):
 *   CANDLE_LIVE_LONG_SMOKE=1
 *   BINANCE_LIVE_CANDLE_SMOKE=1   (provider=binance)
 *   KIS_LIVE_CANDLE_SMOKE=1       (provider=kis-krx | kis-us)
 *
 * Usage:
 *   set -a; . ./.env; . ./.env.local; set +a
 *   CANDLE_LIVE_LONG_SMOKE=1 BINANCE_LIVE_CANDLE_SMOKE=1 \
 *     pnpm exec tsx scripts/candle-live-smoke.ts \
 *       --provider binance --durationMinutes 90 --symbols BTCUSDT,ETHUSDT \
 *       --verifyRest --injectReconnect --output artifacts/candle-smoke
 *
 * The KIS KRX run must be executed during the KRX regular session
 * (09:00–15:30 KST on a trading day); the harness refuses to start outside
 * it unless --allowOffSession is passed (results are then only meaningful
 * for connection liveness). KIS US delayed requires
 * CANDLE_LIVE_KIS_US_DELAYED_ENABLED=true and account entitlement.
 *
 * No credential, approval key, or raw provider frame is ever written to the
 * report; only aggregate counters.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  AssetType,
  MarketCandleSyncMode,
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
import { MarketCandleIngestionService } from '../src/assets/market-candle-ingestion.service';
import { AssetCandlesCacheService } from '../src/assets/asset-candles-cache.service';
import { readLiveCandleConfig } from '../src/assets/live-candle.config';
import { LiveCandleHealthService } from '../src/assets/live-candle-health.service';
import {
  LiveCandleStoreService,
  buildLiveCandleOwnerLeaseKey,
} from '../src/assets/live-candle-store.service';
import { LiveCandleHydratorService } from '../src/assets/live-candle-hydrator.service';
import { LiveCandleOverlayService } from '../src/assets/live-candle-overlay.service';
import { LiveCandlePublisherService } from '../src/assets/live-candle-publisher.service';
import { LiveCandlePipelineService } from '../src/assets/live-candle-pipeline.service';
import { LiveCandleFinalizerService } from '../src/assets/live-candle-finalizer.service';
import { LiveCandleEventNormalizerService } from '../src/assets/live-candle-event-normalizer.service';
import { MarketCandleAggregationService } from '../src/assets/market-candle-aggregation.service';
import { MarketCandleReconciliationService } from '../src/assets/market-candle-reconciliation.service';
import {
  LiveCandleStreamSupervisorService,
  defaultLiveCandleSocketFactory,
} from '../src/realtime/live-candle-stream-supervisor.service';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import { BinancePublicClient } from '../src/providers/binance/binance-public.client';
import { BinanceCandleIngestionService } from '../src/providers/binance/binance-candle.ingestion.service';
import { KisRateLimiterService } from '../src/providers/kis/coordination/kis-rate-limiter.service';
import { KisRequestCoordinatorService } from '../src/providers/kis/coordination/kis-request-coordinator.service';
import { KisAuthClient } from '../src/providers/kis/kis-auth.client';
import { KisQuoteClient } from '../src/providers/kis/kis-quote.client';
import { KisDomesticMinuteAdapter } from '../src/providers/kis/candles/kis-domestic-minute.adapter';
import { KisUsMinuteAdapter } from '../src/providers/kis/candles/kis-us-minute.adapter';
import { KisCandleNormalizerService } from '../src/providers/kis/candles/kis-candle-normalizer.service';
import { KisDomesticFiveMinuteBuilder } from '../src/providers/kis/candles/kis-domestic-five-minute.builder';
import { KisDomesticPeriodAdapter } from '../src/providers/kis/candles/kis-domestic-period.adapter';
import { KisOverseasPeriodAdapter } from '../src/providers/kis/candles/kis-overseas-period.adapter';
import { resolveMarketSession } from '../src/orders/market-calendar.policy';
import { getZonedParts } from '../src/providers/kis/candles/kis-candle-time';

type ProviderArg = 'binance' | 'kis-krx' | 'kis-us';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

const provider = (arg('provider') ?? 'binance') as ProviderArg;
const durationMinutes = Number(arg('durationMinutes') ?? '90');
const symbolsArg = arg('symbols');
const verifyRest = arg('verifyRest') !== undefined;
const injectReconnect = arg('injectReconnect') !== undefined;
const allowOffSession = arg('allowOffSession') !== undefined;
const outputDir = arg('output') ?? join('artifacts', 'candle-smoke');
const maxAssets = Number(arg('maxAssets') ?? '3');

if (process.env.CANDLE_LIVE_LONG_SMOKE !== '1') {
  console.error('CANDLE_LIVE_LONG_SMOKE!=1; refusing to run.');
  process.exit(2);
}
if (provider === 'binance' && process.env.BINANCE_LIVE_CANDLE_SMOKE !== '1') {
  console.error('BINANCE_LIVE_CANDLE_SMOKE!=1; refusing to run.');
  process.exit(2);
}
if (provider !== 'binance' && process.env.KIS_LIVE_CANDLE_SMOKE !== '1') {
  console.error('KIS_LIVE_CANDLE_SMOKE!=1; refusing to run.');
  process.exit(2);
}
if (!Number.isFinite(durationMinutes) || durationMinutes < 1) {
  console.error('--durationMinutes must be a positive number.');
  process.exit(2);
}

const FIVE_MIN = 300_000;

async function main() {
  const startedAt = new Date();
  const gitCommit = (() => {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  })();

  // KRX session guard.
  if (provider === 'kis-krx' && !allowOffSession) {
    const seoul = getZonedParts(new Date(), 'Asia/Seoul');
    const localDate = `${seoul.year}${String(seoul.month).padStart(2, '0')}${String(seoul.day).padStart(2, '0')}`;
    const session = resolveMarketSession('KRX', localDate);
    const now = Date.now();
    if (!session || now < session.openTime.getTime() || now >= session.closeTime.getTime()) {
      console.error(
        `KRX regular session is not open now (session=${session ? `${session.openTime.toISOString()}..${session.closeTime.toISOString()}` : 'closed today'}). ` +
          'Run during 09:00–15:30 KST on a trading day, or pass --allowOffSession for a liveness-only run.',
      );
      process.exit(3);
    }
  }
  if (provider === 'kis-us' && process.env.CANDLE_LIVE_KIS_US_DELAYED_ENABLED !== 'true') {
    console.error('CANDLE_LIVE_KIS_US_DELAYED_ENABLED!=true; the delayed US feed is opt-in.');
    process.exit(3);
  }

  const prisma = new PrismaService();
  const redis = new RedisService(readRedisConfig());
  await prisma.$connect();

  const repository = new MarketCandlesRepository(prisma);
  const stateRepository = new MarketCandleSyncStateRepository(prisma);
  const locks = new RedisLockService(redis);
  const cache = new AssetCandlesCacheService(redis);
  const providerConfig = new ProviderConfigService();
  const httpClient = new ProviderHttpClient();
  const binancePublic = new BinancePublicClient(providerConfig, httpClient);
  const binanceCandles = new BinanceCandleIngestionService(binancePublic);
  const kisLimiter = new KisRateLimiterService(redis);
  const kisCoordinator = new KisRequestCoordinatorService(kisLimiter);
  const kisAuth = new KisAuthClient(providerConfig, kisCoordinator);
  const kisQuote = new KisQuoteClient(providerConfig, kisCoordinator);
  const fiveMinuteIngestion = new MarketCandleIngestionService(
    new KisDomesticMinuteAdapter(kisAuth, kisQuote, providerConfig),
    new KisUsMinuteAdapter(kisAuth, kisQuote, providerConfig),
    new KisCandleNormalizerService(),
    new KisDomesticFiveMinuteBuilder(),
    repository,
    cache,
  );
  const sync = new MarketCandleSyncService(
    prisma,
    repository,
    stateRepository,
    new MarketCandleBackfillLockService(locks),
    fiveMinuteIngestion,
    new KisDomesticPeriodAdapter(kisAuth, kisQuote, providerConfig),
    new KisOverseasPeriodAdapter(kisAuth, kisQuote, providerConfig),
    new KisPeriodCandleNormalizerService(),
    binanceCandles,
    {
      maxPages: 200,
      maxRows: 100_000,
      maxDurationMs: 60_000,
      assetConcurrency: 1,
      incrementalOverlapMinutes: 120,
      lockTtlSeconds: 120,
      lockRenewSeconds: 40,
    },
    cache,
  );

  const liveConfig = {
    ...readLiveCandleConfig(),
    enabled: true,
    binanceEnabled: provider === 'binance',
    kisEnabled: provider !== 'binance',
    kisUsDelayedEnabled: provider === 'kis-us',
  };
  const health = new LiveCandleHealthService();
  const store = new LiveCandleStoreService(redis, health, liveConfig);
  const hydrator = new LiveCandleHydratorService(repository, sync);
  const aggregation = new MarketCandleAggregationService(repository);
  const overlay = new LiveCandleOverlayService(store, repository, aggregation);
  const publisher = new LiveCandlePublisherService(redis, overlay, health);
  const pipeline = new LiveCandlePipelineService(store, hydrator, publisher, health);
  const finalizer = new LiveCandleFinalizerService(
    store,
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
      maxAssets: 50,
      maxPages: 20,
    },
  );

  // Asset selection: only active project assets of the provider's type.
  const assetType =
    provider === 'binance'
      ? AssetType.crypto
      : provider === 'kis-krx'
        ? AssetType.domestic_stock
        : AssetType.us_stock;
  const wantedSymbols = symbolsArg
    ? symbolsArg.split(',').map((value) => value.trim().toUpperCase())
    : null;
  const allAssets = await prisma.asset.findMany({
    where: { isActive: true, assetType },
    select: { id: true, symbol: true, market: true, assetType: true, isActive: true },
    orderBy: [{ symbol: 'asc' }],
  });
  const assets = (wantedSymbols
    ? allAssets.filter((asset) => wantedSymbols.includes(asset.symbol.toUpperCase()))
    : allAssets
  ).slice(0, maxAssets);
  if (assets.length === 0) {
    console.error('No matching active assets; register assets first.');
    process.exit(3);
  }
  // The supervisor loads its own asset list; scope it to the smoke assets.
  const scopedPrisma = {
    asset: {
      findMany: async ({ where }: { where: { assetType: AssetType } }) =>
        assets.filter((asset) => asset.assetType === where.assetType),
    },
  };

  const supervisor = new LiveCandleStreamSupervisorService(
    scopedPrisma as never,
    locks,
    providerConfig,
    kisAuth,
    { publish: async () => true } as never,
    normalizer,
    pipeline,
    health,
    liveConfig,
    defaultLiveCandleSocketFactory,
  );

  const supervisorProvider = provider === 'binance' ? 'binance' : 'kis';
  const metrics = {
    connectionCount: 0,
    forcedReconnectCount: 0,
    leaseTakeoverCount: 0,
    bucketsObserved: new Set<string>(),
    bucketsFinalized: 0,
    resyncEvents: 0,
  };

  console.error(
    JSON.stringify({
      event: 'live_smoke_start',
      provider,
      durationMinutes,
      symbols: assets.map((asset) => asset.symbol),
      verifyRest,
      injectReconnect,
    }),
  );

  supervisor.start();
  finalizer.onModuleInit();

  const endAt = Date.now() + durationMinutes * 60_000;
  let lastConnectedAt: string | null = null;
  let reconnectInjected = false;
  let takeoverInjected = false;

  while (Date.now() < endAt) {
    await sleep(5_000);
    const snapshot = health.snapshot();
    const providerHealth = snapshot.providers[supervisorProvider];
    if (providerHealth.connectedAt && providerHealth.connectedAt !== lastConnectedAt) {
      lastConnectedAt = providerHealth.connectedAt;
      metrics.connectionCount += 1;
    }
    for (const asset of assets) {
      const state = await store.getCurrent(asset.id).catch(() => null);
      if (state) metrics.bucketsObserved.add(`${asset.id}:${state.openTime}`);
    }

    const elapsedRatio = 1 - (endAt - Date.now()) / (durationMinutes * 60_000);
    if (injectReconnect && !reconnectInjected && elapsedRatio >= 0.5) {
      reconnectInjected = true;
      const context = (supervisor as never as {
        contexts: Map<string, { socket: { close(code: number, reason: string): void } | null }>;
      }).contexts.get(supervisorProvider);
      try {
        context?.socket?.close(4999, 'smoke forced reconnect');
        metrics.forcedReconnectCount += 1;
        console.error(JSON.stringify({ event: 'live_smoke_forced_reconnect' }));
      } catch {
        // Socket already gone; the reconnect loop covers it.
      }
    }
    if (injectReconnect && !takeoverInjected && elapsedRatio >= 0.66) {
      takeoverInjected = true;
      // Owner-lease takeover simulation: a foreign token holds the provider
      // lease briefly; the current generation loses ownership and its
      // remaining states must be recovered by the finalizer takeover path.
      await redis.setWithTtl(
        buildLiveCandleOwnerLeaseKey(supervisorProvider),
        `smoke-takeover-${Date.now()}`,
        Math.max(5, Math.ceil(liveConfig.ownerLeaseTtlMs / 1000)),
      );
      metrics.leaseTakeoverCount += 1;
      console.error(JSON.stringify({ event: 'live_smoke_lease_takeover' }));
    }
  }

  console.error(JSON.stringify({ event: 'live_smoke_stopping' }));
  await supervisor.stop();
  // Give the finalizer a final chance to commit due buckets.
  await finalizer.runOnce(new Date());
  await finalizer.onModuleDestroy();

  // Post-run REST verification and reconciliation.
  let driftBeforeReconciliation = 0;
  let driftAfterReconciliation = 0;
  let reconciliationRuns = 0;
  let rowsCorrected = 0;
  // Substantive drift only: OHLC/volume/amount/close-state changes and
  // missing buckets. source_updated_at moves on EVERY REST refetch by design
  // (newer-source-wins bookkeeping), so counting it would report permanent drift.
  const substantiveDrift = (summary: {
    missingRows: number;
    results: {
      ohlcDrift: number;
      volumeDrift: number;
      amountDrift: number;
      closeStateDrift: number;
    }[];
  }) =>
    summary.missingRows +
    summary.results.reduce(
      (total, result) =>
        total +
        result.ohlcDrift +
        result.volumeDrift +
        result.amountDrift +
        result.closeStateDrift,
      0,
    );
  if (verifyRest) {
    const market =
      provider === 'binance' ? 'CRYPTO' : provider === 'kis-krx' ? 'KRX' : 'US';
    const first = await reconciliation.reconcile({
      assetIds: assets.map((asset) => asset.id),
      market: market as never,
      targets: ['5m'],
      now: new Date(),
    });
    reconciliationRuns += 1;
    driftBeforeReconciliation = substantiveDrift(first);
    rowsCorrected = first.correctedRows;
    const second = await reconciliation.reconcile({
      assetIds: assets.map((asset) => asset.id),
      market: market as never,
      targets: ['5m'],
      now: new Date(),
    });
    reconciliationRuns += 1;
    driftAfterReconciliation = substantiveDrift(second);
  }

  // Canonical-row integrity for the observed window.
  const observedOpenTimes = [...metrics.bucketsObserved].map((key) => {
    const [assetId, openTime] = key.split(/:(.+)/u);
    return { assetId, openTime: new Date(openTime) };
  });
  let duplicateCanonicalRows = 0;
  let incompleteClosedRows = 0;
  const finalizedBuckets = new Set<string>();
  for (const { assetId, openTime } of observedOpenTimes) {
    const rows = await repository.findRange({
      assetId,
      interval: '5m',
      from: openTime,
      to: new Date(openTime.getTime() + FIVE_MIN),
    });
    if (rows.length > 1) duplicateCanonicalRows += rows.length - 1;
    for (const row of rows) {
      if (row.isClosed && row.closeTime.getTime() > Date.now()) {
        incompleteClosedRows += 1;
      }
      if (row.isClosed) finalizedBuckets.add(`${assetId}:${row.openTime.toISOString()}`);
    }
  }
  metrics.bucketsFinalized = finalizedBuckets.size;

  const snapshot = health.snapshot();
  const providerHealth = snapshot.providers[supervisorProvider];
  const finishedAt = new Date();
  const summary = {
    gitCommit,
    provider,
    market:
      provider === 'binance' ? 'CRYPTO' : provider === 'kis-krx' ? 'KRX' : 'US',
    symbols: assets.map((asset) => asset.symbol),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMinutes:
      Math.round(((finishedAt.getTime() - startedAt.getTime()) / 60_000) * 10) / 10,
    connectionCount: metrics.connectionCount,
    reconnectCount: providerHealth.reconnectCount,
    forcedReconnectCount: metrics.forcedReconnectCount,
    leaseTakeoverCount: metrics.leaseTakeoverCount,
    subscriptionRequested: providerHealth.subscriptionsRequested,
    subscriptionSucceeded: providerHealth.subscriptionsActive,
    subscriptionFailed: providerHealth.subscriptionsFailed,
    lastHeartbeatAt: providerHealth.lastHeartbeatAt,
    lastFrameAt: providerHealth.lastFrameAt,
    lastEventAt: providerHealth.lastEventAt,
    framesReceived: null as number | null,
    tradeEventsReceived:
      snapshot.liveCandle.eventsAccepted +
      snapshot.liveCandle.eventsDuplicate +
      snapshot.liveCandle.eventsOutOfOrder,
    eventsAccepted: snapshot.liveCandle.eventsAccepted,
    eventsRejected: snapshot.liveCandle.eventsRejected,
    eventsDuplicate: snapshot.liveCandle.eventsDuplicate,
    eventsOutOfOrder: snapshot.liveCandle.eventsOutOfOrder,
    bucketsObserved: metrics.bucketsObserved.size,
    bucketsFinalized: metrics.bucketsFinalized,
    incompleteBuckets: snapshot.liveCandle.incompleteBuckets,
    finalizeSuccess: snapshot.liveCandle.finalizeSuccess,
    finalizeFailure: snapshot.liveCandle.finalizeFailure,
    recoveryRepairSuccess: snapshot.liveCandle.recoveryRepairSuccess,
    recoveryRepairFailure: snapshot.liveCandle.recoveryRepairFailure,
    reconciliationRuns,
    rowsInserted: null as number | null,
    rowsUpdated: rowsCorrected,
    driftBeforeReconciliation,
    driftAfterReconciliation,
    duplicateCanonicalRows,
    incompleteClosedRows,
    staleEvents: null as number | null,
    resyncEvents: metrics.resyncEvents,
    result:
      providerHealth.subscriptionsActive > 0 &&
      snapshot.liveCandle.eventsAccepted > 0 &&
      duplicateCanonicalRows === 0 &&
      incompleteClosedRows === 0 &&
      (!verifyRest || driftAfterReconciliation === 0)
        ? 'passed'
        : 'failed',
    failureReasons: [
      ...(providerHealth.subscriptionsActive > 0 ? [] : ['no active subscription']),
      ...(snapshot.liveCandle.eventsAccepted > 0 ? [] : ['no events accepted']),
      ...(duplicateCanonicalRows === 0 ? [] : ['duplicate canonical rows']),
      ...(incompleteClosedRows === 0 ? [] : ['incomplete closed rows']),
      ...(!verifyRest || driftAfterReconciliation === 0
        ? []
        : ['drift after reconciliation']),
    ],
  };

  mkdirSync(outputDir, { recursive: true });
  const artifactPath = join(
    outputDir,
    `${provider === 'binance' ? 'binance' : provider === 'kis-krx' ? 'kis-krx' : 'kis-us-delayed'}-${finishedAt
      .toISOString()
      .replace(/[:.]/gu, '-')}.json`,
  );
  writeFileSync(artifactPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.error(`artifact: ${artifactPath}`);

  await prisma.$disconnect();
  await redis.onModuleDestroy();
  if (summary.result !== 'passed') process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
