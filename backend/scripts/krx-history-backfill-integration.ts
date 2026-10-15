/**
 * L10-B — initial KRX history backfill (design v2.1 §10.7) against a local
 * mock KOSCOM, on a disposable *_test PostgreSQL and a local Redis.
 *
 * The real KoscomClient, call counters, market map and adapter feed
 * MarketCandleSyncService (candle-baseline-sync's 1d repair path) and
 * MarketCandleLongSyncService (candle:long-backfill's KRX backfill path,
 * recorded through the same Ops-locked run group into ops_job_runs); G4-H
 * then judges what was stored. No real provider call.
 *
 * Fixture: 4 stocks (2 KOSPI, 2 KOSDAQ), cohort A on the Monday after, the
 * clock pinned to Friday 2026-10-16 18:00 KST. The mock derives every dated
 * daily bar from that session's 10-minute rows (CSAT day, delayed opens and
 * closing auctions included), except one session of one stock whose
 * 10-minute rows contradict the daily bar (held). The first 4h run is
 * interrupted mid-way (operator stop).
 *
 * Checks: before the backfill G4-H reports everything missing; the 1d
 * backfill takes 6–7 pages per stock and G4-H 1d becomes ready (577 confirmed
 * bars); the interrupted 4h run is recorded as failed with its progress and
 * the rerun fetches only what is not stored (no duplicate rows, no refetch of
 * verified sessions); the contradicting session is held, recorded in the run
 * and reported by G4-H as `held` (never `ready`) while the other stocks are
 * `ready`; a further rerun calls the provider only for the held session and
 * never for 1d (stored bars are the references), and the incremental 1d
 * upkeep reads at most one page per stock; the call counters equal the
 * provider log, with the 4h work counted as `backfill` (P4).
 *
 *   KRX_HISTORY_BACKFILL_DB_INTEGRATION=1 DATABASE_URL=<local *_test db> \
 *   REDIS_URL=redis://127.0.0.1:<port> pnpm tsx scripts/krx-history-backfill-integration.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import {
  AssetType,
  CurrencyCode,
  MarketCandleSyncMode,
  OpsJobName,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { RedisLockService } from '../src/redis/redis-lock.service';
import { KoscomClient } from '../src/providers/koscom/koscom.client';
import { KoscomCallBudgetService } from '../src/providers/koscom/koscom-call-budget.service';
import { KoscomMarketMapService } from '../src/providers/koscom/koscom-market-map.service';
import { KoscomCandleAdapter } from '../src/providers/koscom/koscom-candle.adapter';
import {
  KoscomConfigService,
  readKoscomConfig,
} from '../src/providers/koscom/koscom.config';
import { KisCandleNormalizerService } from '../src/providers/kis/candles/kis-candle-normalizer.service';
import { KisDomesticFiveMinuteBuilder } from '../src/providers/kis/candles/kis-domestic-five-minute.builder';
import { KisPeriodCandleNormalizerService } from '../src/providers/kis/candles/kis-period-candle-normalizer.service';
import { MarketCandlesRepository } from '../src/assets/market-candles.repository';
import { MarketCandleSyncStateRepository } from '../src/assets/market-candle-sync-state.repository';
import { MarketCandleBackfillLockService } from '../src/assets/market-candle-backfill-lock.service';
import { MarketCandleIngestionService } from '../src/assets/market-candle-ingestion.service';
import { MarketCandleSyncService } from '../src/assets/market-candle-sync.service';
import { readMarketCandleSyncConfig } from '../src/assets/market-candle-sync.config';
import { AssetCandlesCacheService } from '../src/assets/asset-candles-cache.service';
import { readCandleCacheConfig } from '../src/assets/asset-candles-cache.config';
import { buildCandleGenerationKey } from '../src/assets/asset-candles-cache.keys';
import {
  MARKET_CANDLE_LONG_SYNC_LOCK_KEY,
  MarketCandleLongSyncService,
} from '../src/assets/market-candle-long-sync.service';
import { planKrxTenMinuteBuckets } from '../src/assets/market-candle-krx-history';
import { KrxCollectionGateDiagnostics } from '../src/assets/krx-collection-gates';
import { readKrxCentralCandlesConfig } from '../src/assets/krx-central-candles.config';
import {
  resolveMarketSession,
  type MarketSessionWindow,
} from '../src/orders/market-calendar.policy';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import {
  runLongBackfillGroup,
  type LongBackfillResults,
} from './lib/candle-long-backfill-run';

const dbUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) &&
    dbUrl.pathname.endsWith('_test'),
  'Use a disposable local *_test PostgreSQL database.',
);
assert.ok(
  ['localhost', '127.0.0.1'].includes(
    new URL(process.env.REDIS_URL ?? 'redis://invalid').hostname,
  ),
  'Use a local Redis.',
);

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const kst = (local: string) => Date.parse(`${local}+09:00`);
// Friday after the close: today's session is complete, so the 4h backfill
// window (97 sessions) holds today plus the 96 G4-H sessions.
const NOW = kst('2026-10-16T18:00:00');

const base = randomInt(810000, 880000);
const SYMBOLS = {
  kospiA: String(base),
  kospiB: String(base + 1),
  kosdaqA: String(base + 2),
  kosdaqHeld: String(base + 3),
};
const KOSPI = [SYMBOLS.kospiA, SYMBOLS.kospiB];
const KOSDAQ = [SYMBOLS.kosdaqA, SYMBOLS.kosdaqHeld];
// Its 10-minute rows contradict the dated daily bar (DAILY_OHLC_MISMATCH).
const HELD_DATE = '20260812';
const COHORTS = [
  {
    id: 'cohort-l10b',
    // Activation is planned for the Monday after the backfill weekend.
    obligationStart: new Date(kst('2026-10-19T00:00:00')).toISOString(),
    symbols: Object.values(SYMBOLS),
  },
];

// ---- KOSCOM fixture ---------------------------------------------------------
type Logged = { path: string; query: Record<string, string> };
const requests: Logged[] = [];
const operatorStop = { controller: new AbortController(), afterTenMinute: 0 };

function session(date: string): MarketSessionWindow {
  return resolveMarketSession('KRX', date)!;
}

/** END-labelled 10-minute rows of a session: every grid label, auction included. */
function tenMinuteRows(symbol: string, day: MarketSessionWindow) {
  const dayNumber = Math.round(Date.parse(`${day.localDate}T00:00:00Z`) / DAY);
  const level = 50_000 + ((Number(symbol) + dayNumber * 7) % 97) * 10;
  const labels = planKrxTenMinuteBuckets(day)
    .flatMap((bucket) => [...bucket.requiredLabels, ...bucket.optionalLabels])
    .sort((a, b) => a - b);
  return labels.map((label, i) => {
    const price = level + i * 5;
    return {
      label,
      open: price,
      high: price + 20,
      low: price - 10,
      close: price + 5,
      volume: 100 + i,
      amount: (price + 5) * (100 + i),
    };
  });
}

function dailyBar(symbol: string, day: MarketSessionWindow) {
  const rows = tenMinuteRows(symbol, day);
  return {
    trdDd: day.localDate.replaceAll('-', ''),
    opnprc: String(rows[0].open),
    hgprc: String(Math.max(...rows.map((row) => row.high))),
    lwprc: String(Math.min(...rows.map((row) => row.low))),
    trdPrc: String(rows.at(-1)!.close),
    accTrdvol: String(rows.reduce((sum, row) => sum + row.volume, 0)),
    accTrdval: String(rows.reduce((sum, row) => sum + row.amount, 0)),
  };
}

function hhmmss(ms: number): string {
  return new Date(ms + 9 * 60 * MIN)
    .toISOString()
    .slice(11, 19)
    .replaceAll(':', '');
}

function compactDays(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(
    `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`,
  );
  const end = Date.parse(
    `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00Z`,
  );
  for (let day = start; day <= end; day += DAY)
    out.push(new Date(day).toISOString().slice(0, 10).replaceAll('-', ''));
  return out;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const query = Object.fromEntries(url.searchParams);
  requests.push({ path: url.pathname, query });
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-ratelimit-limit-day', '50000');
  res.setHeader('x-ratelimit-remaining-day', String(50000 - requests.length));
  const parts = url.pathname.split('/');
  if (url.pathname.endsWith('/lists')) {
    const symbols = url.pathname.includes('/kospi/')
      ? KOSPI
      : url.pathname.includes('/kosdaq/')
        ? KOSDAQ
        : ['990002'];
    res.end(
      JSON.stringify({
        isuLists: symbols.map((isuSrtCd) => ({ isuSrtCd })),
      }),
    );
    return;
  }
  if (url.pathname.endsWith('/history') && query.trnsmCycleTpCd === 'D') {
    // Newest first, at most reqCnt rows; a bar is published 15 min after the close.
    const symbol = parts[parts.length - 2];
    const hisLists = compactDays(query.inqStrtDd, query.inqEndDd)
      .map((date) => resolveMarketSession('KRX', date))
      .filter(
        (day): day is MarketSessionWindow =>
          day !== null && day.closeTime.getTime() + 15 * MIN <= NOW,
      )
      .reverse()
      .slice(0, Number(query.reqCnt))
      .map((day) => dailyBar(symbol, day));
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        result: { isuSrtCd: symbol, hisLists },
      }),
    );
    return;
  }
  if (url.pathname.endsWith('/intraday') && query.inddCycleTpCd === '600') {
    const symbol = parts[parts.length - 2];
    const date = query.inqStrtDd;
    const rows = tenMinuteRows(symbol, session(date));
    if (symbol === SYMBOLS.kosdaqHeld && date === HELD_DATE)
      rows[rows.length - 1].high += 1;
    if (
      operatorStop.afterTenMinute > 0 &&
      requests.filter((entry) => categoryOf(entry) === 'ten_minute').length ===
        operatorStop.afterTenMinute
    )
      operatorStop.controller.abort();
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        result: {
          isuSrtCd: symbol,
          trdDd: date,
          hisLists: rows.map((row) => ({
            inddTm: `${hhmmss(row.label)}00`,
            inddOpnprc: String(row.open),
            inddHgprc: String(row.high),
            inddLwprc: String(row.low),
            inddClsprc: String(row.close),
            inddTrdvol: String(row.volume),
            inddTrdval: String(row.amount),
          })),
        },
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

function categoryOf(entry: Logged) {
  if (entry.path.endsWith('/lists')) return 'lists';
  if (entry.path.endsWith('/intraday')) return 'ten_minute';
  return 'daily';
}

function count(from: number, category: string, symbol?: string) {
  return requests
    .slice(from)
    .filter(
      (entry) =>
        categoryOf(entry) === category &&
        (symbol === undefined || entry.path.includes(`/${symbol}/`)),
    ).length;
}

// ---- wiring -------------------------------------------------------------------
const namespace = `krx-l10b-${randomUUID().slice(0, 8)}`;
const prisma = new PrismaService();
const redis = new RedisService();
const locks = new RedisLockService(redis);
let fixtureBaseUrl = '';
class FixtureConfig extends KoscomConfigService {
  override getConfig() {
    return {
      ...readKoscomConfig({
        PROVIDER_INGESTION_ENABLED: 'true',
        KOSCOM_API_KEY: 'fixture-key',
      }),
      baseUrl: fixtureBaseUrl,
      namespace,
      minIntervalMs: 1,
    };
  }
}
const koscomConfig = new FixtureConfig();
const budget = new KoscomCallBudgetService(redis);
const client = new KoscomClient(koscomConfig, redis, locks, budget);
const markets = new KoscomMarketMapService(client, redis, koscomConfig);
const adapter = new KoscomCandleAdapter(client, markets);
const repository = new MarketCandlesRepository(prisma);
const states = new MarketCandleSyncStateRepository(prisma);
const backfillLocks = new MarketCandleBackfillLockService(locks);
const cache = new AssetCandlesCacheService(
  redis,
  readCandleCacheConfig({ CANDLE_CACHE_ENABLED: 'true' }),
);
const sync = new MarketCandleSyncService(
  prisma,
  repository,
  states,
  backfillLocks,
  new MarketCandleIngestionService(
    adapter,
    {} as never,
    new KisCandleNormalizerService(),
    new KisDomesticFiveMinuteBuilder(),
    repository,
    cache,
  ),
  adapter,
  {} as never,
  new KisPeriodCandleNormalizerService(),
  {} as never,
  readMarketCandleSyncConfig({}),
  cache,
);
const centralConfig = readKrxCentralCandlesConfig(
  { KOSCOM_CENTRAL_CANDLES_ENABLED: 'false' },
  COHORTS,
);
const longSync = new MarketCandleLongSyncService(
  prisma,
  repository,
  {} as never,
  backfillLocks,
  cache,
  {} as never,
  {} as never,
  adapter,
  client,
  redis,
  centralConfig,
);
const opsLocks = new OpsJobLockService(prisma);
const opsRuns = new OpsJobRunService(prisma);
const gates = new KrxCollectionGateDiagnostics(prisma, states, centralConfig);

const assetIds = new Map<string, string>();
const runIds: string[] = [];

async function createAssets() {
  const others = await prisma.asset.count({
    where: { assetType: AssetType.domestic_stock, isActive: true },
  });
  assert.equal(
    others,
    0,
    'The test database must hold no other active domestic asset.',
  );
  for (const [key, symbol] of Object.entries(SYMBOLS)) {
    const asset = await prisma.asset.create({
      data: {
        symbol,
        name: `KRX L10-B ${key}`,
        market: KOSPI.includes(symbol) ? 'KOSPI' : 'KOSDAQ',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
        priceCurrency: CurrencyCode.KRW,
        settlementCurrency: CurrencyCode.KRW,
        isActive: true,
      },
    });
    assetIds.set(symbol, asset.id);
  }
}

async function cleanup() {
  const ids = [...assetIds.values()];
  await Promise.allSettled(
    ids.map((id) => redis.delete(buildCandleGenerationKey(id))),
  );
  if (runIds.length)
    await prisma.opsJobRun.deleteMany({ where: { id: { in: runIds } } });
  if (ids.length) {
    await prisma.marketCandle.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.marketCandleSyncState.deleteMany({
      where: { assetId: { in: ids } },
    });
    await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  }
}

/** candle:long-backfill --market krx --apply, as the command runs it. */
async function longBackfill(signal: AbortSignal) {
  let results: LongBackfillResults = {};
  const runsBefore = await prisma.opsJobRun.findMany({
    where: { jobName: OpsJobName.market_candle_long_sync },
    select: { id: true },
  });
  const ok = await runLongBackfillGroup({
    locks: opsLocks,
    runs: opsRuns,
    jobName: OpsJobName.market_candle_long_sync,
    lockKey: MARKET_CANDLE_LONG_SYNC_LOCK_KEY,
    apply: true,
    metadataJson: { markets: ['krx'], fixture: 'l10b' },
    signal,
    execute: async (groupSignal) => {
      results = {
        krx: await longSync.syncKrx({
          mode: 'backfill',
          now: new Date(NOW),
          dryRun: false,
          signal: groupSignal,
          assetIds: [...assetIds.values()],
          // The command's --krx-min-call-interval-ms; spacing is not under test.
          krx: { minCallIntervalMs: 0 },
        }),
      };
      return results;
    },
  });
  const known = new Set(runsBefore.map((run) => run.id));
  const run = (
    await prisma.opsJobRun.findMany({
      where: { jobName: OpsJobName.market_candle_long_sync },
      select: { id: true, status: true, errorCode: true },
    })
  ).filter((entry) => !known.has(entry.id));
  assert.equal(run.length, 1, 'one ops_job_runs row per backfill run');
  runIds.push(run[0].id);
  return { ok, summary: results.krx, run: run[0] };
}

async function g4h() {
  const report = await gates.g4h({
    now: new Date(NOW),
    assetIds: [...assetIds.values()],
  });
  return new Map(report.map((entry) => [entry.symbol, entry]));
}

async function main() {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  fixtureBaseUrl = `http://127.0.0.1:${address.port}`;
  const logged = { log: console.log, warn: console.warn };
  const quiet = () => undefined;
  try {
    await prisma.$connect();
    await createAssets();
    const ids = [...assetIds.values()];
    const sessions97 = Array.from({ length: 200 }, (_, back) =>
      new Date(NOW - back * DAY).toISOString().slice(0, 10).replaceAll('-', ''),
    )
      .map((date) => resolveMarketSession('KRX', date))
      .filter((day): day is MarketSessionWindow => day !== null)
      .slice(0, 97);
    const bucketsPerAsset = sessions97.reduce(
      (sum, day) => sum + planKrxTenMinuteBuckets(day).length,
      0,
    );

    // ---- before: nothing stored ------------------------------------------------
    const before = await g4h();
    for (const entry of before.values()) {
      assert.equal(entry.daily.state, 'incomplete');
      assert.equal(entry.daily.sessionsExpected, 577, '576 + today');
      assert.equal(entry.daily.missing.count, 577, 'no bar yet');
      assert.equal(entry.fourHour.state, 'incomplete');
      assert.equal(entry.fourHour.missing.count, 96, 'no 4h session yet');
      assert.equal(
        entry.intraday[0].state,
        'pre_obligation',
        'activation is after the backfill',
      );
    }

    // ---- 1d 576: candle-baseline-sync --mode repair --days 875 --target 1d -----
    console.log = quiet;
    const dailyStart = requests.length;
    const daily = await sync.syncAssets({
      targets: ['1d'],
      mode: MarketCandleSyncMode.repair,
      from: new Date(NOW - 875 * DAY),
      to: new Date(NOW),
      activeOnly: false,
      assetIds: ids,
      dryRun: false,
      now: new Date(NOW),
    });
    console.log = logged.log;
    assert.equal(daily.failedFeeds, 0, '1d backfill feeds succeed');
    assert.equal(daily.coverageCompleteFeeds, 4, '1d coverage complete');
    const dailyPages = Object.values(SYMBOLS).map((symbol) =>
      count(dailyStart, 'daily', symbol),
    );
    for (const pages of dailyPages)
      assert.ok(
        pages >= 6 && pages <= 7,
        `1d pages per stock ${pages} ∈ [6,7]`,
      );
    const afterDaily = await g4h();
    for (const entry of afterDaily.values()) {
      assert.equal(entry.daily.state, 'ready', `${entry.symbol} 1d ready`);
      assert.equal(entry.daily.confirmed, 577);
      assert.equal(entry.fourHour.state, 'incomplete', '4h not yet');
    }

    // ---- 4h 97: candle:long-backfill --market krx, stopped by the operator -----
    const firstStart = requests.length;
    operatorStop.afterTenMinute = 150;
    console.warn = quiet;
    const first = await longBackfill(operatorStop.controller.signal);
    console.warn = logged.warn;
    assert.equal(first.ok, false, 'a stopped backfill is not successful');
    assert.equal(first.run.status, 'failed');
    assert.equal(first.run.errorCode, 'MARKET_CANDLE_LONG_BACKFILL_CANCELED');
    assert.equal(first.summary.stopReason, 'canceled');
    const firstCalls = count(firstStart, 'ten_minute');
    assert.ok(
      firstCalls >= 150 && firstCalls <= 152,
      `stopped near the 150th call (${firstCalls})`,
    );
    assert.equal(count(firstStart, 'daily'), 0, 'stored 1d bars are reused');
    const mid = await g4h();
    const midComplete = [...mid.values()].reduce(
      (sum, entry) => sum + entry.fourHour.complete,
      0,
    );
    assert.ok(
      midComplete > 0 && midComplete < 4 * 96,
      `partial progress is stored (${midComplete} sessions)`,
    );

    // ---- rerun to completion ------------------------------------------------------
    operatorStop.afterTenMinute = 0;
    const secondStart = requests.length;
    const second = await longBackfill(new AbortController().signal);
    assert.equal(second.ok, true, 'held sessions are outcomes, not failures');
    assert.equal(second.run.status, 'succeeded');
    const secondCalls = count(secondStart, 'ten_minute');
    // Every (stock, session) is fetched once, except a session whose call was
    // in flight when the first run stopped (fetched again, never stored twice).
    const perSession = new Map<string, number>();
    for (const entry of requests.slice(firstStart))
      if (categoryOf(entry) === 'ten_minute') {
        const key = `${entry.path}:${entry.query.inqStrtDd}`;
        perSession.set(key, (perSession.get(key) ?? 0) + 1);
      }
    assert.equal(perSession.size, 4 * 97, 'every (stock, session) was fetched');
    const refetched = [...perSession.values()].filter((n) => n > 1).length;
    assert.ok(
      refetched <= 2,
      `at most the in-flight calls refetched (${refetched})`,
    );
    assert.equal(firstCalls + secondCalls, 4 * 97 + refetched);
    const heldSeries = second.summary.series.find(
      (series) => series.seriesId === assetIds.get(SYMBOLS.kosdaqHeld),
    )!;
    assert.deepEqual(
      heldSeries.held.map((entry) => `${entry.date}:${entry.reason}`),
      [`${HELD_DATE}:DAILY_OHLC_MISMATCH`],
      'the contradicting session is held and recorded',
    );
    for (const symbol of Object.values(SYMBOLS)) {
      const rows = await prisma.marketCandle.count({
        where: { assetId: assetIds.get(symbol)!, interval: '4h' },
      });
      assert.equal(
        rows,
        symbol === SYMBOLS.kosdaqHeld ? bucketsPerAsset - 2 : bucketsPerAsset,
        `${symbol}: every planned bucket stored once (held session not stored)`,
      );
    }

    // ---- G4-H after the backfill -------------------------------------------------
    const after = await g4h();
    for (const symbol of [SYMBOLS.kospiA, SYMBOLS.kospiB, SYMBOLS.kosdaqA]) {
      const entry = after.get(symbol)!;
      assert.equal(entry.daily.state, 'ready');
      assert.equal(entry.fourHour.state, 'ready', `${symbol} 4h ready`);
      assert.equal(entry.fourHour.complete, 96);
    }
    const heldEntry = after.get(SYMBOLS.kosdaqHeld)!;
    assert.equal(heldEntry.fourHour.state, 'held', 'held is never ready');
    assert.equal(heldEntry.fourHour.complete, 95);
    assert.deepEqual(heldEntry.fourHour.held, [
      {
        date: `${HELD_DATE.slice(0, 4)}-${HELD_DATE.slice(4, 6)}-${HELD_DATE.slice(6)}`,
        reason: 'DAILY_OHLC_MISMATCH',
      },
    ]);

    // ---- reruns: only the held session goes to the provider ----------------------
    const thirdStart = requests.length;
    const third = await longBackfill(new AbortController().signal);
    assert.equal(third.ok, true);
    assert.equal(count(thirdStart, 'ten_minute'), 1, 'only the held session');
    assert.equal(count(thirdStart, 'daily'), 0, 'no 1d call');
    const incrementalStart = requests.length;
    console.log = quiet;
    const incremental = await sync.syncAssets({
      targets: ['1d'],
      mode: MarketCandleSyncMode.incremental,
      activeOnly: false,
      assetIds: ids,
      now: new Date(NOW),
    });
    console.log = logged.log;
    assert.equal(incremental.failedFeeds, 0);
    // The daily upkeep re-reads the newest page (today's bar) once per stock:
    // the §5.4 budget's ~1.1 calls per stock and trading day.
    const incrementalDaily = count(incrementalStart, 'daily');
    assert.ok(incrementalDaily <= 4, 'at most one 1d page per stock');

    // ---- counters equal the provider log; 4h work is P4 backfill -----------------
    await new Promise((resolve) => setTimeout(resolve, 200)); // fire-and-forget counters
    const counters = await budget.readQuotaDay(namespace, new Date(NOW));
    assert.equal(counters.counts.total, requests.length, 'counters = HTTP log');
    assert.equal(
      counters.counts.backfill,
      count(0, 'ten_minute'),
      '10-minute history counted as backfill',
    );

    logged.log(
      JSON.stringify({
        l10b: 'ok',
        dailyPagesPerStock: dailyPages,
        tenMinuteCalls: {
          stoppedRun: firstCalls,
          rerun: secondCalls,
          refetchedInFlight: refetched,
          heldRerun: 1,
        },
        incrementalDailyCalls: incrementalDaily,
        g4h: Object.fromEntries(
          [...after.entries()].map(([symbol, entry]) => [
            symbol,
            {
              daily: entry.daily.state,
              fourHour: entry.fourHour.state,
              held: entry.fourHour.held.length,
            },
          ]),
        ),
        counters: counters.counts,
        providerRequests: requests.length,
      }),
    );
  } finally {
    console.log = logged.log;
    console.warn = logged.warn;
    mock.timers.reset();
    await cleanup().catch(() => undefined);
    server.close();
    await prisma.$disconnect();
    await redis.onModuleDestroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
