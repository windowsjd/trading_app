/**
 * Post-run REST verification for a completed live smoke: reconciles an
 * explicit window for the given symbols and reports SUBSTANTIVE drift
 * (OHLC / volume / amount / close-state / missing buckets) before and after.
 * source_updated_at-only changes are bookkeeping, not drift.
 *
 *   set -a; . ./.env; . ./.env.local; set +a
 *   PROVIDER_INGESTION_ENABLED=true CANDLE_LIVE_LONG_SMOKE=1 \
 *     pnpm exec tsx scripts/candle-live-smoke-report.ts \
 *       --market CRYPTO --symbols BTCUSDT,ETHUSDT \
 *       --from 2026-07-13T10:25:00Z --to 2026-07-13T12:05:00Z \
 *       --output artifacts/candle-smoke
 *
 * NOT_RUN mode — records that a provider smoke could NOT be executed
 * (closed market, missing entitlement/credentials) without contacting any
 * provider, database, or Redis. A smoke that did not run must be recorded as
 * not_run, never as passed:
 *
 *   pnpm run smoke:candle-report -- \
 *     --provider kis-us --result not_run \
 *     --reason "US regular session closed"
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertReleaseCleanTree,
  resolveSmokeGitIdentity,
} from './lib/smoke-git-identity';
import {
  buildNotRunReport,
  SMOKE_REPORT_SCHEMA_VERSION,
} from './lib/smoke-report';
import { AssetType } from '../src/generated/prisma/client';
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
import { LiveCandleStoreService } from '../src/assets/live-candle-store.service';
import { LiveCandleOverlayService } from '../src/assets/live-candle-overlay.service';
import { LiveCandlePublisherService } from '../src/assets/live-candle-publisher.service';
import { MarketCandleAggregationService } from '../src/assets/market-candle-aggregation.service';
import { MarketCandleReconciliationService } from '../src/assets/market-candle-reconciliation.service';
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

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

// NOT_RUN mode runs BEFORE the long-smoke gate: it performs no provider,
// database, or Redis access — it only records, with git identity, that a
// provider smoke could not be executed.
const resultArg = arg('result');
if (resultArg !== undefined && resultArg !== 'not_run') {
  console.error(
    '--result only accepts not_run; passed/failed are computed by the drift verification itself.',
  );
  process.exit(2);
}
if (resultArg === 'not_run') {
  try {
    const identity = resolveSmokeGitIdentity();
    const report = buildNotRunReport({
      identity,
      provider: arg('provider') ?? '',
      reason: arg('reason') ?? '',
    });
    const notRunOutputDir = arg('output') ?? join('artifacts', 'candle-smoke');
    mkdirSync(notRunOutputDir, { recursive: true });
    const artifactPath = join(
      notRunOutputDir,
      `not-run-${report.provider}-${report.createdAt.replace(/[:.]/gu, '-')}.json`,
    );
    writeFileSync(artifactPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.error(`artifact: ${artifactPath}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

if (process.env.CANDLE_LIVE_LONG_SMOKE !== '1') {
  console.error('CANDLE_LIVE_LONG_SMOKE!=1; refusing to run.');
  process.exit(2);
}

const market = (arg('market') ?? 'CRYPTO') as 'CRYPTO' | 'KRX' | 'US';
const symbols = (arg('symbols') ?? '')
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const from = new Date(arg('from') ?? '');
const to = new Date(arg('to') ?? '');
const outputDir = arg('output') ?? join('artifacts', 'candle-smoke');
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
  console.error('--from/--to must form a valid half-open window.');
  process.exit(2);
}

async function main() {
  // Identity first: no artifact is ever produced without a resolved commit,
  // and a dirty tree is refused unless SMOKE_ALLOW_DIRTY=1 (recorded as
  // gitDirty=true; never valid release evidence).
  const gitIdentity = resolveSmokeGitIdentity();
  assertReleaseCleanTree(gitIdentity);

  const prisma = new PrismaService();
  const redis = new RedisService(readRedisConfig());
  await prisma.$connect();
  const repository = new MarketCandlesRepository(prisma);
  const locks = new RedisLockService(redis);
  const cache = new AssetCandlesCacheService(redis);
  const providerConfig = new ProviderConfigService();
  const httpClient = new ProviderHttpClient();
  const kisLimiter = new KisRateLimiterService(redis);
  const kisCoordinator = new KisRequestCoordinatorService(kisLimiter);
  const kisAuth = new KisAuthClient(providerConfig, kisCoordinator);
  const kisQuote = new KisQuoteClient(providerConfig, kisCoordinator);
  const sync = new MarketCandleSyncService(
    prisma,
    repository,
    new MarketCandleSyncStateRepository(prisma),
    new MarketCandleBackfillLockService(locks),
    new MarketCandleIngestionService(
      new KisDomesticMinuteAdapter(kisAuth, kisQuote, providerConfig),
      new KisUsMinuteAdapter(kisAuth, kisQuote, providerConfig),
      new KisCandleNormalizerService(),
      new KisDomesticFiveMinuteBuilder(),
      repository,
      cache,
    ),
    new KisDomesticPeriodAdapter(kisAuth, kisQuote, providerConfig),
    new KisOverseasPeriodAdapter(kisAuth, kisQuote, providerConfig),
    new KisPeriodCandleNormalizerService(),
    new BinanceCandleIngestionService(
      new BinancePublicClient(providerConfig, httpClient),
    ),
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
  const liveConfig = { ...readLiveCandleConfig(), enabled: true };
  const health = new LiveCandleHealthService();
  const store = new LiveCandleStoreService(redis, health, liveConfig);
  const aggregation = new MarketCandleAggregationService(repository);
  const overlay = new LiveCandleOverlayService(store, repository, aggregation);
  const publisher = new LiveCandlePublisherService(redis, overlay, health);
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
      maxPages: 40,
    },
  );

  const assetType =
    market === 'CRYPTO'
      ? AssetType.crypto
      : market === 'KRX'
        ? AssetType.domestic_stock
        : AssetType.us_stock;
  const assets = (
    await prisma.asset.findMany({
      where: { isActive: true, assetType },
      select: { id: true, symbol: true },
    })
  ).filter(
    (asset) =>
      symbols.length === 0 || symbols.includes(asset.symbol.toUpperCase()),
  );
  if (assets.length === 0) {
    console.error('No matching assets.');
    process.exit(3);
  }

  const substantive = (summary: {
    missingRows: number;
    results: {
      ohlcDrift: number;
      volumeDrift: number;
      amountDrift: number;
      closeStateDrift: number;
      sourceTimestampDrift: number;
      checkedRows: number;
    }[];
  }) => ({
    missingRows: summary.missingRows,
    ohlcDrift: sum(summary.results, 'ohlcDrift'),
    volumeDrift: sum(summary.results, 'volumeDrift'),
    amountDrift: sum(summary.results, 'amountDrift'),
    closeStateDrift: sum(summary.results, 'closeStateDrift'),
    sourceTimestampOnly: sum(summary.results, 'sourceTimestampDrift'),
    checkedRows: sum(summary.results, 'checkedRows'),
    substantiveTotal:
      summary.missingRows +
      sum(summary.results, 'ohlcDrift') +
      sum(summary.results, 'volumeDrift') +
      sum(summary.results, 'amountDrift') +
      sum(summary.results, 'closeStateDrift'),
  });

  const reconcileOnce = async () =>
    reconciliation.reconcile({
      assetIds: assets.map((asset) => asset.id),
      market: market as never,
      targets: ['5m'],
      from,
      to,
      now: new Date(),
    });

  const first = substantive(await reconcileOnce());
  const second = substantive(await reconcileOnce());
  const finishedAt = new Date();
  const summary = {
    schemaVersion: SMOKE_REPORT_SCHEMA_VERSION,
    gitCommit: gitIdentity.gitCommit,
    gitBranch: gitIdentity.gitBranch,
    gitDirty: gitIdentity.gitDirty,
    market,
    symbols: assets.map((asset) => asset.symbol),
    window: { from: from.toISOString(), to: to.toISOString() },
    firstPass: first,
    secondPass: second,
    driftBeforeReconciliation: first.substantiveTotal,
    driftAfterReconciliation: second.substantiveTotal,
    result: second.substantiveTotal === 0 ? 'passed' : 'failed',
  };
  mkdirSync(outputDir, { recursive: true });
  const artifactPath = join(
    outputDir,
    `rest-drift-${market.toLowerCase()}-${finishedAt.toISOString().replace(/[:.]/gu, '-')}.json`,
  );
  writeFileSync(artifactPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.error(`artifact: ${artifactPath}`);
  await prisma.$disconnect();
  await redis.onModuleDestroy();
  if (summary.result !== 'passed') process.exitCode = 1;
}

function sum<T extends Record<K, number>, K extends string>(
  rows: readonly T[],
  key: K,
): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : error,
  );
  process.exitCode = 1;
});
