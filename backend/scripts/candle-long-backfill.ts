/**
 * Initial backfill (and manual catch-up) of the long-range COMPLETED 4h history.
 *
 *   spot    Binance Spot native 4h klines         → market_candles '4h'
 *   krx     KOSCOM 10-minute history, verified     → market_candles '4h'
 *           per session against the dated daily     (koscom_history_10m)
 *   futures Binance USDⓈ-M contract 4h klines      → futures_market_candles
 *
 * Never runs on deploy and never inside a chart request. It is a thin wrapper
 * around MarketCandleLongSyncService (the same code the scheduled Ops jobs run)
 * and takes the SAME Ops job lock, so it never overlaps a scheduled run.
 * Stored rows are the progress record: rerunning after an interruption only
 * fetches what is still missing.
 *
 * Usage (from backend/; pin DATABASE_URL — .env.local may point at Render):
 *   pnpm candle:long-backfill --market spot --market futures            # plan
 *   pnpm candle:long-backfill --market spot --market futures --apply
 *   pnpm candle:long-backfill --market krx --apply --max-calls 800
 *
 * Flags: --market spot|krx|futures (repeatable, required), --apply | --dry-run
 * (default), --days N (crypto, 1..180, default 96), --sessions N (KRX, 1..125,
 * default 97), --asset-id, --instrument-id (repeatable),
 * --include-inactive-futures, --max-calls N (KRX KOSCOM calls, default 1500),
 * --min-remaining-daily N (stop at this observed KOSCOM daily remainder,
 * default 20000), --min-call-interval-ms N (KRX pacing, default 1000),
 * --allow-during-krx-session, --no-fetch-missing-daily.
 */
import 'reflect-metadata';

import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import {
  parseCandleLongBackfillArgs,
  type CandleLongBackfillArgs,
} from './lib/candle-long-backfill-args';

loadRuntimeEnv();

import { OpsJobName, OpsJobTrigger } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { readRedisConfig } from '../src/redis/redis.config';
import { RedisLockService } from '../src/redis/redis-lock.service';
import { AssetCandlesCacheService } from '../src/assets/asset-candles-cache.service';
import { MarketCandlesRepository } from '../src/assets/market-candles.repository';
import { FuturesMarketCandlesRepository } from '../src/assets/market-candle-futures.repository';
import { MarketCandleBackfillLockService } from '../src/assets/market-candle-backfill-lock.service';
import {
  FUTURES_CANDLE_SYNC_LOCK_KEY,
  MARKET_CANDLE_LONG_SYNC_LOCK_KEY,
  MarketCandleLongSyncService,
  type LongCandleMarket,
  type LongCandleSyncInput,
  type LongCandleSyncSummary,
} from '../src/assets/market-candle-long-sync.service';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import { BinancePublicClient } from '../src/providers/binance/binance-public.client';
import { BinanceCandleIngestionService } from '../src/providers/binance/binance-candle.ingestion.service';
import { BinanceUsdmKlineClient } from '../src/providers/binance/binance-kline-usdm.client';
import { KoscomConfigService } from '../src/providers/koscom/koscom.config';
import { KoscomClient } from '../src/providers/koscom/koscom.client';
import { KoscomMarketMapService } from '../src/providers/koscom/koscom-market-map.service';
import { KoscomCandleAdapter } from '../src/providers/koscom/koscom-candle.adapter';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { MarketSessionOverrideLoaderService } from '../src/orders/market-calendar/market-session-override.loader.service';
import { getMarketSessionOverrideRuntimeStatus } from '../src/orders/market-calendar/market-session-override.store';

const LOCK_TTL_SECONDS = 900;
const LOCK_EXTEND_MS = 60_000;

function createService(prisma: PrismaService, redis: RedisService) {
  const repository = new MarketCandlesRepository(prisma);
  const providerConfig = new ProviderConfigService();
  const httpClient = new ProviderHttpClient(redis);
  const koscomConfig = new KoscomConfigService();
  const locks = new RedisLockService(redis);
  const koscomClient = new KoscomClient(koscomConfig, redis, locks);
  return new MarketCandleLongSyncService(
    prisma,
    repository,
    new FuturesMarketCandlesRepository(prisma),
    new MarketCandleBackfillLockService(locks),
    new AssetCandlesCacheService(redis),
    new BinanceCandleIngestionService(
      new BinancePublicClient(providerConfig, httpClient),
    ),
    new BinanceCandleIngestionService(new BinanceUsdmKlineClient(httpClient)),
    new KoscomCandleAdapter(
      koscomClient,
      new KoscomMarketMapService(koscomClient, redis, koscomConfig),
    ),
    koscomClient,
  );
}

function syncInput(
  market: LongCandleMarket,
  args: CandleLongBackfillArgs,
  signal: AbortSignal,
): LongCandleSyncInput {
  return {
    mode: 'backfill',
    now: new Date(),
    dryRun: !args.apply,
    signal,
    ...(market !== 'futures' && args.assetIds.length
      ? { assetIds: args.assetIds }
      : {}),
    ...(market === 'futures' && args.instrumentIds.length
      ? {
          instrumentIds: args.instrumentIds,
          includeInactiveFutures: args.includeInactiveFutures,
        }
      : {}),
    days: args.days,
    sessions: args.sessions,
    krx: {
      maxCalls: args.krxMaxCalls,
      minRemainingDaily: args.krxMinRemainingDaily,
      minCallIntervalMs: args.krxMinCallIntervalMs,
      allowDuringSession: args.allowDuringKrxSession,
      fetchMissingDaily: args.fetchMissingDaily,
    },
  };
}

function print(summary: LongCandleSyncSummary) {
  console.log(
    `\n[${summary.market}] mode=${summary.mode} dryRun=${summary.dryRun} window=${summary.window.from ?? '-'} → ${summary.window.to ?? '-'} (${summary.window.size} ${summary.window.unit})`,
  );
  for (const series of summary.series) {
    console.log(
      [
        series.status.toUpperCase().padEnd(11),
        series.symbol.padEnd(10),
        `expected=${series.expected}`,
        `missing=${series.missingBefore}`,
        `written=${series.rowsWritten}`,
        `${summary.dryRun ? 'plannedCalls' : 'calls'}=${series.providerCalls}`,
        series.held.length ? `held=${series.held.length}` : '',
        series.pending.length ? `pending=${series.pending.length}` : '',
        series.errorCode ? `error=${series.errorCode}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    for (const held of series.held.slice(0, 10)) {
      console.log(`    held ${held.date} ${held.reason}`);
    }
  }
  console.log(
    `totals series=${summary.totals.series} written=${summary.totals.rowsWritten} calls=${summary.totals.providerCalls} held=${summary.totals.held} pending=${summary.totals.pending} failed=${summary.totals.failed} stop=${summary.stopReason ?? '-'}` +
      (summary.observedRemainingDaily !== undefined
        ? ` koscomRemainingDaily(min observed)=${summary.observedRemainingDaily ?? '-'}`
        : ''),
  );
}

async function runGroup(
  service: MarketCandleLongSyncService,
  locks: OpsJobLockService,
  runs: OpsJobRunService,
  jobName: OpsJobName,
  lockKey: string,
  markets: LongCandleMarket[],
  args: CandleLongBackfillArgs,
  signal: AbortSignal,
): Promise<boolean> {
  const execute = async () => {
    const results: Record<string, LongCandleSyncSummary> = {};
    for (const market of markets) {
      const input = syncInput(market, args, signal);
      results[market] =
        market === 'spot'
          ? await service.syncSpot(input)
          : market === 'krx'
            ? await service.syncKrx(input)
            : await service.syncFutures(input);
      print(results[market]);
    }
    return results;
  };
  if (!args.apply) {
    await execute();
    return true;
  }
  const lock = await locks.acquireLock({
    jobName,
    lockKey,
    ttlSeconds: LOCK_TTL_SECONDS,
  });
  if (!lock.acquired) {
    console.error(
      `${jobName}: another run holds the Ops job lock (${lockKey}) until ${lock.expiresAt?.toISOString() ?? '?'}; nothing was started.`,
    );
    return false;
  }
  const run = await runs.createRunning({
    jobName,
    trigger: OpsJobTrigger.manual_script,
    requestedBy: 'script:candle-long-backfill',
    lockKey,
    metadataJson: { markets, days: args.days, sessions: args.sessions },
  });
  const extend = setInterval(() => {
    void locks
      .extendLock({
        lockKey,
        ownerId: lock.ownerId,
        ttlSeconds: LOCK_TTL_SECONDS,
      })
      .catch(() => false);
  }, LOCK_EXTEND_MS);
  try {
    const results = await execute();
    const failed = Object.values(results).some((s) => s.totals.failed > 0);
    if (failed) {
      await runs.recordFailed(run, {
        errorCode: 'MARKET_CANDLE_LONG_BACKFILL_FAILED',
        errorMessage: 'Long-range 4h backfill finished with failed series.',
        resultJson: results,
      });
    } else {
      await runs.recordSucceeded(run, { resultJson: results });
    }
    return !failed;
  } catch (error) {
    await runs.recordFailed(run, {
      errorCode: 'MARKET_CANDLE_LONG_BACKFILL_FAILED',
      errorMessage: 'Long-range 4h backfill stopped with an error.',
    });
    throw error;
  } finally {
    clearInterval(extend);
    await locks
      .releaseLock({ lockKey, ownerId: lock.ownerId })
      .catch(() => false);
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const args = parseCandleLongBackfillArgs(argv);
  requireDatabaseUrl();
  console.log(`database: ${formatDatabaseTarget(process.env.DATABASE_URL)}`);
  console.log(
    `markets=${args.markets.join(',')} apply=${args.apply} days=${args.days} sessions=${args.sessions}`,
  );
  const prisma = new PrismaService();
  const calendarLoader = new MarketSessionOverrideLoaderService(prisma);
  const controller = new AbortController();
  const onSignal = () => {
    console.error('Stopping after the current provider call…');
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let redis: RedisService | undefined;
  try {
    await prisma.$connect();
    // Same calendar lifecycle as the server: KRX sessions honour operator
    // overrides, and a failed snapshot load aborts instead of guessing.
    await calendarLoader.onModuleInit();
    if (getMarketSessionOverrideRuntimeStatus().state !== 'ready') {
      throw new Error(
        'Initial market-session override load failed; the backfill was not started.',
      );
    }
    redis = new RedisService(readRedisConfig());
    const service = createService(prisma, redis);
    const locks = new OpsJobLockService(prisma);
    const runs = new OpsJobRunService(prisma);
    let ok = true;
    const assetMarkets = args.markets.filter((m) => m !== 'futures');
    if (assetMarkets.length > 0) {
      ok =
        (await runGroup(
          service,
          locks,
          runs,
          OpsJobName.market_candle_long_sync,
          MARKET_CANDLE_LONG_SYNC_LOCK_KEY,
          assetMarkets,
          args,
          controller.signal,
        )) && ok;
    }
    if (args.markets.includes('futures') && !controller.signal.aborted) {
      ok =
        (await runGroup(
          service,
          locks,
          runs,
          OpsJobName.futures_candle_sync,
          FUTURES_CANDLE_SYNC_LOCK_KEY,
          ['futures'],
          args,
          controller.signal,
        )) && ok;
    }
    if (!args.apply) {
      console.log('\ndry run: no provider call and no write happened.');
    }
    return ok ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await calendarLoader.onModuleDestroy();
    try {
      await prisma.$disconnect();
    } finally {
      await redis?.onModuleDestroy();
    }
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
