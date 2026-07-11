import { spawnSync } from 'node:child_process';

const RUN_SYNC_DB_SMOKE = process.env.MARKET_CANDLE_SYNC_DB_SMOKE === '1';
const itDbIntegration = RUN_SYNC_DB_SMOKE ? it : it.skip;

// Opt-in DB fixture smoke for the checkpointed candle sync pipeline. It needs
// PostgreSQL (DATABASE_URL) and Redis (REDIS_URL, for the asset/feed backfill
// lock). Providers are replaced with fixture pages; the repositories,
// checkpoint store, locks, normalizer, and aggregation run for real. Only
// migrate deploy is executed — never reset/drop/truncate — and only rows
// created by this test are cleaned up.
describe('Market candle sync DB smoke', () => {
  itDbIntegration(
    'stores 5m/1d/1w fixtures, survives a mid-run failure via checkpoint resume, stays idempotent, and aggregates higher intervals',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        getPnpmCommand(),
        ['exec', 'tsx', '-e', MARKET_CANDLE_SYNC_DB_SMOKE_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Market candle sync DB smoke runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('market candle sync db smoke ok');
    },
    180_000,
  );
});

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runDbIntegrationPrepare() {
  const result = spawnSync(getPnpmCommand(), ['run', 'test:db:prepare'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        'Market candle sync DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const MARKET_CANDLE_SYNC_DB_SMOKE_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { AssetType, CurrencyCode } from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { RedisService } from './src/redis/redis.service';
import { RedisLockService } from './src/redis/redis-lock.service';
import { MarketCandlesRepository } from './src/assets/market-candles.repository';
import { MarketCandleSyncStateRepository } from './src/assets/market-candle-sync-state.repository';
import { MarketCandleBackfillLockService } from './src/assets/market-candle-backfill-lock.service';
import { MarketCandleAggregationService } from './src/assets/market-candle-aggregation.service';
import { MarketCandleSyncService } from './src/assets/market-candle-sync.service';
import { KisPeriodCandleNormalizerService } from './src/providers/kis/candles/kis-period-candle-normalizer.service';
import { readMarketCandleSyncConfig } from './src/assets/market-candle-sync.config';

const SUFFIX = Date.now().toString(36).toUpperCase();
const TEST_MARKETS = {
  crypto: 'BINANCE',
  domestic: 'KOSPI',
  us: 'NASDAQ',
};
const FIVE_MIN = 5 * 60_000;
const DAY = 24 * 60 * 60_000;
// Fixed, closed reference time: 2026-07-10 00:00:00 UTC (Friday).
const NOW = new Date('2026-07-10T00:00:00Z');

const prisma = new PrismaService();
const redis = new RedisService();
const repository = new MarketCandlesRepository(prisma);
const stateRepository = new MarketCandleSyncStateRepository(prisma);
const lockService = new MarketCandleBackfillLockService(
  new RedisLockService(redis),
);
const normalizer = new KisPeriodCandleNormalizerService();
const aggregation = new MarketCandleAggregationService(repository);

const assetIds: string[] = [];

function candleFixture(openMs: number) {
  return {
    openTime: new Date(openMs),
    closeTime: new Date(openMs + FIVE_MIN),
    open: '100',
    high: '102',
    low: '99',
    close: '101',
    volume: '10',
    amount: '1010',
    isClosed: true,
    sourceUpdatedAt: NOW,
  };
}

// Crypto 5m fixtures: one full 4h UTC bucket (20:00–24:00) served as three
// pages, with one injectable failure between them to exercise resume.
const CRYPTO_5M_START = NOW.getTime() - 4 * 60 * 60_000;
const CRYPTO_5M_COUNT = 48;
let failNextCryptoPage = false;
const binanceStub = {
  async fetchKlinesPage(input: {
    interval: string;
    from: Date;
    to: Date;
    cursor?: { startTime: number } | null;
  }) {
    if (input.interval === '5m') {
      const start = input.cursor?.startTime ?? input.from.getTime();
      if (start > CRYPTO_5M_START && failNextCryptoPage) {
        failNextCryptoPage = false;
        throw new Error('injected mid-run provider failure');
      }
      const pageSize = 20;
      const candles = [] as ReturnType<typeof candleFixture>[];
      for (
        let openMs = Math.max(start, CRYPTO_5M_START);
        openMs < input.to.getTime() && candles.length < pageSize;
        openMs += FIVE_MIN
      ) {
        candles.push(candleFixture(openMs));
      }
      const last = candles[candles.length - 1];
      const nextStart = last ? last.openTime.getTime() + FIVE_MIN : null;
      const finished = !nextStart || nextStart >= input.to.getTime();
      return {
        candles,
        providerReturnedRows: candles.length,
        acceptedRows: candles.length,
        rejectedRows: 0,
        duplicateRows: 0,
        nextCursor: finished ? null : { startTime: nextStart },
        stopReason: finished ? 'target_reached' : null,
        complete: finished,
      };
    }
    // 1d / 1w fixtures: a single terminal page.
    const intervalMs = input.interval === '1d' ? DAY : 7 * DAY;
    const gridOffset = input.interval === '1w' ? 4 * DAY : 0;
    const candles = [] as ReturnType<typeof candleFixture>[];
    const firstGrid =
      Math.ceil((input.from.getTime() - gridOffset) / intervalMs) * intervalMs +
      gridOffset;
    for (
      let openMs = firstGrid;
      openMs < input.to.getTime() && openMs <= NOW.getTime();
      openMs += intervalMs
    ) {
      const candle = candleFixture(openMs);
      candle.closeTime = new Date(openMs + intervalMs);
      candles.push(candle);
    }
    return {
      candles,
      providerReturnedRows: candles.length,
      acceptedRows: candles.length,
      rejectedRows: 0,
      duplicateRows: 0,
      nextCursor: null,
      stopReason: 'target_reached',
      complete: true,
    };
  },
};

// KIS 5m fixtures (domestic + US): one segment worth of candles per call.
function fiveMinuteFixtureResult(input: { from: Date; to: Date }) {
  const candles = [] as ReturnType<typeof candleFixture>[];
  const firstGrid = Math.ceil(input.from.getTime() / FIVE_MIN) * FIVE_MIN;
  for (
    let openMs = firstGrid;
    openMs < input.to.getTime() && candles.length < 12;
    openMs += FIVE_MIN
  ) {
    candles.push(candleFixture(openMs));
  }
  return {
    pagesFetched: 1,
    providerReturnedRows: candles.length,
    acceptedRows: candles.length,
    rejectedRows: 0,
    duplicateRows: 0,
    candles,
    complete: true,
    stopReason: 'target_reached',
    oldestOpenTime: candles[0]?.openTime ?? null,
    latestOpenTime: candles[candles.length - 1]?.openTime ?? null,
  };
}
const fiveMinuteStub = {
  fetchDomesticFiveMinuteCandles: async (input: { from: Date; to: Date }) =>
    fiveMinuteFixtureResult(input),
  fetchUsFiveMinuteCandles: async (input: { from: Date; to: Date }) =>
    fiveMinuteFixtureResult(input),
};

// KIS period fixtures: three recent weekday rows per market.
function periodRows(dateField: string, fields: Record<string, string>) {
  return ['20260709', '20260708', '20260707'].map((date) => ({
    value: { [dateField]: date, ...fields },
    receivedAt: NOW,
    sequence: 0,
  }));
}
const domesticPeriodStub = {
  async fetchPeriodPage() {
    return {
      state: 'ok',
      rows: periodRows('stck_bsop_date', {
        stck_clpr: '101',
        stck_oprc: '100',
        stck_hgpr: '102',
        stck_lwpr: '99',
        acml_vol: '1000',
        acml_tr_pbmn: '101000',
      }),
      providerReturnedRows: 3,
      blankRows: 0,
      oldestDate: '20260101',
      latestDate: '20260709',
      trCont: null,
    };
  },
};
const overseasPeriodStub = {
  async fetchPeriodPage() {
    return {
      state: 'ok',
      rows: periodRows('xymd', {
        clos: '101',
        open: '100',
        high: '102',
        low: '99',
        tvol: '1000',
        tamt: '101000',
      }),
      providerReturnedRows: 3,
      blankRows: 0,
      oldestDate: '20260101',
      latestDate: '20260709',
      trCont: null,
    };
  },
};

const syncService = new MarketCandleSyncService(
  prisma,
  repository,
  stateRepository,
  lockService,
  fiveMinuteStub as never,
  domesticPeriodStub as never,
  overseasPeriodStub as never,
  normalizer,
  binanceStub as never,
  readMarketCandleSyncConfig({}),
);

async function createAsset(input: {
  symbol: string;
  market: string;
  assetType: (typeof AssetType)[keyof typeof AssetType];
  currencyCode: (typeof CurrencyCode)[keyof typeof CurrencyCode];
}) {
  const asset = await prisma.asset.create({
    data: {
      symbol: input.symbol,
      name: 'Candle Sync Smoke ' + input.symbol,
      market: input.market,
      currencyCode: input.currencyCode,
      priceCurrency: input.currencyCode,
      settlementCurrency: input.currencyCode,
      assetType: input.assetType,
      isActive: true,
    },
  });
  assetIds.push(asset.id);
  return asset;
}

async function countRows(assetId: string, interval: string) {
  return prisma.marketCandle.count({ where: { assetId, interval } });
}

async function cleanup() {
  if (assetIds.length === 0) return;
  await prisma.marketCandle.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.marketCandleSyncState.deleteMany({
    where: { assetId: { in: assetIds } },
  });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
}

async function main() {
  await prisma.$connect();
  try {
    const crypto = await createAsset({
      symbol: 'SMK' + SUFFIX,
      market: TEST_MARKETS.crypto,
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
    });
    const domestic = await createAsset({
      symbol: '999999',
      market: TEST_MARKETS.domestic + '-SMOKE-' + SUFFIX,
      assetType: AssetType.domestic_stock,
      currencyCode: CurrencyCode.KRW,
    });
    const us = await createAsset({
      symbol: 'SMKU' + SUFFIX,
      market: TEST_MARKETS.us,
      assetType: AssetType.us_stock,
      currencyCode: CurrencyCode.USD,
    });
    // The domestic asset was created with a synthetic market for uniqueness;
    // point it back at a KRX market name for descriptor resolution.
    await prisma.asset.update({
      where: { id: domestic.id },
      data: { market: 'KOSPI' },
    });

    // 1) Crypto 5m with an injected mid-run provider failure.
    failNextCryptoPage = true;
    const failedRun = await syncService.syncAsset({
      assetId: crypto.id,
      targets: ['5m'],
      mode: 'repair' as never,
      from: new Date(CRYPTO_5M_START),
      to: NOW,
      now: NOW,
    });
    assert.equal(failedRun.feeds[0].status, 'failed');
    assert.equal(failedRun.feeds[0].stopReason, 'provider_error');
    const afterFailure = await countRows(crypto.id, '5m');
    assert.equal(afterFailure, 20, 'first page must be persisted');
    const checkpoint = await stateRepository.findResumable(crypto.id, '5m');
    assert.ok(checkpoint, 'a resumable checkpoint must remain');
    assert.ok(checkpoint.cursorJson, 'the checkpoint must keep its cursor');

    // 2) Resume completes the range from the stored checkpoint.
    const resumed = await syncService.syncAsset({
      assetId: crypto.id,
      targets: ['5m'],
      resume: true,
      now: NOW,
    });
    assert.equal(resumed.feeds[0].status, 'completed');
    assert.equal(resumed.feeds[0].resumed, true);
    assert.equal(await countRows(crypto.id, '5m'), CRYPTO_5M_COUNT);

    // 3) Re-running the same sync is idempotent: row counts do not change.
    const rerun = await syncService.syncAsset({
      assetId: crypto.id,
      targets: ['5m'],
      mode: 'repair' as never,
      from: new Date(CRYPTO_5M_START),
      to: NOW,
      resume: false,
      now: NOW,
    });
    assert.equal(rerun.feeds[0].status, 'completed');
    assert.equal(await countRows(crypto.id, '5m'), CRYPTO_5M_COUNT);

    // 4) Crypto 1d and 1w fixtures persist provider-native rows.
    const cryptoPeriod = await syncService.syncAsset({
      assetId: crypto.id,
      targets: ['1d', '1w'],
      mode: 'repair' as never,
      from: new Date(NOW.getTime() - 21 * DAY),
      to: NOW,
      now: NOW,
    });
    assert.equal(cryptoPeriod.failedFeeds, 0);
    assert.ok((await countRows(crypto.id, '1d')) > 0);
    assert.ok((await countRows(crypto.id, '1w')) > 0);

    // 5) Domestic and US fixture pages persist 5m/1d/1w rows.
    for (const asset of [domestic, us]) {
      const synced = await syncService.syncAsset({
        assetId: asset.id,
        targets: ['5m', '1d', '1w'],
        mode: 'repair' as never,
        from: new Date('2026-07-07T00:00:00Z'),
        to: new Date('2026-07-09T23:00:00Z'),
        now: NOW,
      });
      assert.equal(
        synced.failedFeeds,
        0,
        'fixture sync must not fail for ' + asset.symbol,
      );
      assert.ok((await countRows(asset.id, '5m')) > 0);
      assert.ok((await countRows(asset.id, '1d')) > 0);
      assert.ok((await countRows(asset.id, '1w')) > 0);
    }

    // 6) Higher intervals aggregate from the stored 5m rows.
    for (const interval of ['15m', '30m', '1h', '4h'] as const) {
      const aggregated = await aggregation.aggregateStoredCandles({
        assetId: crypto.id,
        assetType: AssetType.crypto,
        interval,
        from: new Date(CRYPTO_5M_START),
        to: NOW,
        now: NOW,
      });
      assert.ok(
        aggregated.candles.length > 0,
        'aggregation must produce ' + interval + ' buckets',
      );
      const closed = aggregated.candles.filter((bucket) => bucket.complete);
      assert.ok(closed.length > 0, 'complete buckets expected for ' + interval);
    }
    const hourly = await aggregation.aggregateStoredCandles({
      assetId: crypto.id,
      assetType: AssetType.crypto,
      interval: '1h',
      from: new Date(CRYPTO_5M_START),
      to: NOW,
      now: NOW,
    });
    assert.equal(hourly.candles.length, 4);
    assert.equal(hourly.candles[0].volume.toFixed(), '120');

    console.log('market candle sync db smoke ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
