/**
 * Seed and inspect the stored 5-minute candle BASELINE that the 15m/30m/1h/4h
 * charts are aggregated from.
 *
 * This is a thin operator wrapper around the existing checkpointed
 * `MarketCandleSyncService.syncAssets` (the same code path the Ops
 * `market_candle_sync` job runs) plus the existing coverage repository — no
 * sync, page, lock or coverage logic is duplicated here.
 *
 * Usage (from backend/):
 *   # what does the store already cover?
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --report
 *
 *   # plan only, no provider calls and no writes
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --dry-run
 *
 *   # seed the 35-day 5m baseline for every active asset (resumable)
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --apply
 *
 *   # seed provider-native daily/weekly baselines for selected assets
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --apply --days 365 \
 *     --target 1d --target 1w --asset-id <uuid>
 *
 *   # keep the tail fresh afterwards (cheap; run on a schedule)
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --apply --mode incremental
 *
 * Flags:
 *   --report                 coverage report only (no provider calls)
 *   --apply | --dry-run      run for real / plan only (default: --dry-run)
 *   --mode initial|incremental|repair   default: initial
 *   --days N                 baseline window, default 35 (the 5m retention)
 *   --target 5m|1d|1w        repeatable; default: 5m
 *   --asset-type domestic_stock|us_stock|crypto   repeatable
 *   --asset-id <uuid>        repeatable; overrides --asset-type
 *   --max-assets N           process at most N assets
 *   --no-resume              start fresh instead of resuming a checkpoint
 *
 * `--report` needs PostgreSQL only. The sync paths boot the application
 * context, so they additionally need Redis (backfill locks) and the real
 * provider credentials (KIS for stocks, Binance for crypto) — the same
 * requirements the Ops job has. Nothing is printed except aggregate counters
 * and coverage timestamps; no credential or provider payload is logged.
 */
import 'reflect-metadata';

import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import {
  parseCandleBaselineArgs,
  type CandleBaselineArgs,
} from './lib/candle-baseline-args';

loadRuntimeEnv();

import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { readRedisConfig } from '../src/redis/redis.config';
import { RedisLockService } from '../src/redis/redis-lock.service';
import { AssetCandlesCacheService } from '../src/assets/asset-candles-cache.service';
import { MarketCandlesRepository } from '../src/assets/market-candles.repository';
import { MarketCandleBackfillLockService } from '../src/assets/market-candle-backfill-lock.service';
import { MarketCandleIngestionService } from '../src/assets/market-candle-ingestion.service';
import { MarketCandleSyncService } from '../src/assets/market-candle-sync.service';
import { readMarketCandleSyncConfig } from '../src/assets/market-candle-sync.config';
import { MarketCandleSyncStateRepository } from '../src/assets/market-candle-sync-state.repository';
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
import { KisPeriodCandleNormalizerService } from '../src/providers/kis/candles/kis-period-candle-normalizer.service';
import { MarketCandleSyncMode } from '../src/generated/prisma/client';

const DAY_MS = 24 * 60 * 60_000;

/**
 * The sync dependencies, wired explicitly (the same objects the Nest module
 * provides). This mirrors the release smoke harness: booting the whole
 * application context here would also start the live-candle pipeline and the
 * realtime sockets, which an operator command must not do.
 */
function createSyncService(prisma: PrismaService, redis: RedisService) {
  const repository = new MarketCandlesRepository(prisma);
  const cache = new AssetCandlesCacheService(redis);
  const providerConfig = new ProviderConfigService();
  const httpClient = new ProviderHttpClient();
  const coordinator = new KisRequestCoordinatorService(
    new KisRateLimiterService(redis),
  );
  const kisAuth = new KisAuthClient(providerConfig, coordinator);
  const kisQuote = new KisQuoteClient(providerConfig, coordinator);
  return new MarketCandleSyncService(
    prisma,
    repository,
    new MarketCandleSyncStateRepository(prisma),
    new MarketCandleBackfillLockService(new RedisLockService(redis)),
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
    readMarketCandleSyncConfig(),
    cache,
  );
}

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : '-';
}

async function report(
  prisma: PrismaService,
  states: MarketCandleSyncStateRepository,
  args: CandleBaselineArgs,
  now: Date,
): Promise<number> {
  const from = new Date(now.getTime() - args.days * DAY_MS);
  const assets = await prisma.asset.findMany({
    where: {
      isActive: true,
      ...(args.assetIds.length ? { id: { in: args.assetIds } } : {}),
      ...(args.assetTypes.length ? { assetType: { in: args.assetTypes } } : {}),
    },
    orderBy: [{ assetType: 'asc' }, { symbol: 'asc' }],
    select: { id: true, symbol: true, assetType: true },
    ...(args.maxAssets ? { take: args.maxAssets } : {}),
  });

  let ready = 0;
  console.log(
    `5m baseline coverage for ${assets.length} active asset(s), window ${iso(from)} → ${iso(now)}`,
  );
  for (const asset of assets) {
    // Same evidence the serving path uses (union of coverage-audited runs).
    const coverage = await states.findCandleCoverage(asset.id, '5m', from, now);
    // "READY" = the chart path can trust the window: coverage starts at the
    // requested start, has no interior hole, and is at most one day behind.
    const ready5m =
      coverage.startsAtRequestedFrom &&
      !coverage.hasInteriorGap &&
      coverage.contiguousCoveredTo !== null &&
      now.getTime() - coverage.contiguousCoveredTo.getTime() <= DAY_MS;
    if (ready5m) ready += 1;
    console.log(
      [
        ready5m ? 'READY   ' : 'MISSING ',
        asset.assetType.padEnd(15),
        asset.symbol.padEnd(10),
        `startsAtFrom=${coverage.startsAtRequestedFrom}`,
        `coveredTo=${iso(coverage.contiguousCoveredTo)}`,
        `interiorGap=${coverage.hasInteriorGap}`,
        `lastCompletedAt=${iso(coverage.newestCompletedAt)}`,
      ].join(' '),
    );
  }
  console.log(
    `\n${ready}/${assets.length} asset(s) can serve 15m/30m/1h/4h charts from the database for this window.`,
  );
  return assets.length === 0 || ready === assets.length ? 0 : 1;
}

/**
 * The coverage report only needs PostgreSQL, so it runs without booting the
 * application context (which also wires Redis, the provider clients and the
 * live-candle pipeline). Operators can therefore check readiness on a machine
 * that has nothing but the database.
 */
async function runReport(args: CandleBaselineArgs): Promise<number> {
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    return await report(
      prisma,
      new MarketCandleSyncStateRepository(prisma),
      args,
      new Date(),
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<number> {
  const args = parseCandleBaselineArgs(process.argv.slice(2));
  requireDatabaseUrl();
  console.log(`database: ${formatDatabaseTarget(process.env.DATABASE_URL)}`);

  if (args.report) return runReport(args);

  // Syncing runs the real thing: provider clients, Redis backfill locks and
  // the checkpointed sync service, exactly as the Ops job does.
  const prisma = new PrismaService();
  await prisma.$connect();
  const redis = new RedisService(readRedisConfig());
  const syncService = createSyncService(prisma, redis);
  try {
    const now = new Date();
    const from = new Date(now.getTime() - args.days * DAY_MS);
    console.log(
      `mode=${args.mode} dryRun=${!args.apply} window=${iso(from)} → ${iso(now)} feeds=${args.targets.join(',')}`,
    );
    const summary = await syncService.syncAssets({
      targets: args.targets,
      mode: args.mode,
      // incremental resolves its own start from the newest stored candle; an
      // explicit from/to is what makes initial/repair cover the baseline.
      ...(args.mode === MarketCandleSyncMode.incremental
        ? {}
        : { from, to: now }),
      activeOnly: true,
      resume: args.resume,
      dryRun: !args.apply,
      ...(args.assetIds.length ? { assetIds: args.assetIds } : {}),
      ...(args.assetTypes.length ? { assetTypes: args.assetTypes } : {}),
      ...(args.maxAssets ? { maxAssets: args.maxAssets } : {}),
      now,
    });

    for (const asset of summary.assets) {
      for (const feed of asset.feeds) {
        console.log(
          [
            feed.coverageComplete ? 'COVERED ' : 'PARTIAL ',
            asset.symbol.padEnd(10),
            `status=${feed.status}`,
            `stop=${feed.stopReason}`,
            `rows=${feed.writtenRows}`,
            `covered=[${iso(feed.coveredFrom)}, ${iso(feed.coveredTo)})`,
            feed.errorCode ? `error=${feed.errorCode}` : '',
          ].join(' '),
        );
      }
    }
    console.log(
      `\nassets=${summary.processedAssets}/${summary.requestedAssets} feeds=${summary.totalFeeds} ` +
        `coverageComplete=${summary.coverageCompleteFeeds} ` +
        `completedWithIncompleteCoverage=${summary.completedWithIncompleteCoverageFeeds} ` +
        `failed=${summary.failedFeeds}`,
    );
    if (!args.apply) {
      console.log('dry run: no provider call and no write happened.');
    }
    return summary.failedFeeds > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
