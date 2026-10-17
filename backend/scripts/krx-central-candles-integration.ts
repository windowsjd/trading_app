/**
 * Central KRX candle collection — PostgreSQL + Redis integration (design
 * v2.1 §10.6/§10.7: L3, L6, L10-A slice, compaction, counters).
 *
 * A local HTTP server plays KOSCOM (lists, 1-minute intraday, daily/weekly
 * history); the real KoscomClient, call counters, market map, adapter,
 * builder, MarketCandleSyncService (locks, checkpoints, upsert, audit),
 * KrxCentralCandleService, compaction, loader and KRX DB-only serving run
 * against a disposable local database and Redis. No real provider call.
 *
 *   KRX_CENTRAL_CANDLES_DB_INTEGRATION=1 DATABASE_URL=<local *_test db> \
 *   REDIS_URL=redis://127.0.0.1:<port> pnpm tsx scripts/krx-central-candles-integration.ts
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
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { RedisLockService } from '../src/redis/redis-lock.service';
import { KoscomClient } from '../src/providers/koscom/koscom.client';
import { KoscomCallBudgetService } from '../src/providers/koscom/koscom-call-budget.service';
import { KoscomMarketMapService } from '../src/providers/koscom/koscom-market-map.service';
import { KoscomCandleAdapter } from '../src/providers/koscom/koscom-candle.adapter';
import {
  KOSCOM_MINUTE_SOURCE,
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
import { KrxCentralCandleService } from '../src/assets/krx-central-candle.service';
import { KrxCheckpointCompactionService } from '../src/assets/krx-checkpoint-compaction.service';
import { KrxCollectionGateDiagnostics } from '../src/assets/krx-collection-gates';
import {
  krxFiveMinuteBridge,
  krxIntradayTickTimes,
  krxSessionSlotState,
} from '../src/assets/krx-candle-collection.policy';
import { readKrxCentralCandlesConfig } from '../src/assets/krx-central-candles.config';
import { CandleReadPlanBuilder } from '../src/assets/candle-read-plan.builder';
import { CandleDatabaseLoader } from '../src/assets/candle-database.loader';
import { MarketCandleAggregationService } from '../src/assets/market-candle-aggregation.service';
import { CandleResponseBuilder } from '../src/assets/candle-response.builder';
import { readCandleServingConfig } from '../src/assets/candle-serving.config';
import { CandleServingService } from '../src/assets/candle-serving.service';
import type { ParsedAssetCandlesQuery } from '../src/assets/asset-candles.service';
import { resolveMarketSession } from '../src/orders/market-calendar.policy';

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
const kst = (local: string) => Date.parse(`${local}+09:00`);
const DAY1 = '2026-10-15';
const DAY2 = '2026-10-16';
const day1 = resolveMarketSession('KRX', '20261015')!;
const day2 = resolveMarketSession('KRX', '20261016')!;

// Unique six-digit fixture symbols (never an existing local asset).
const base = randomInt(810000, 880000);
const SYMBOLS = {
  clean: String(base),
  missing: String(base + 1),
  late: String(base + 2),
  cohort2: String(base + 3),
};
const COHORTS = [
  {
    id: 'cohort-1',
    obligationStart: new Date(kst(`${DAY1}T00:00:00`)).toISOString(),
    symbols: [SYMBOLS.clean, SYMBOLS.missing, SYMBOLS.late],
  },
  {
    id: 'cohort-2',
    obligationStart: new Date(kst(`${DAY2}T00:00:00`)).toISOString(),
    symbols: [SYMBOLS.cohort2],
  },
];

// ---- KOSCOM fixture ---------------------------------------------------------
let fakeNow = kst(`${DAY1}T08:00:00`);
const AUCTION_PUBLISH_DELAY_MS = 5 * MIN;
const requests: { path: string; query: Record<string, string> }[] = [];

function minuteHidden(symbol: string, endMs: number): boolean {
  const local = new Date(endMs + 9 * 60 * MIN).toISOString().slice(11, 16);
  const date = new Date(endMs + 9 * 60 * MIN).toISOString().slice(0, 10);
  // A permanently missing bucket: no prints 10:15–10:19 on day 1.
  if (symbol === SYMBOLS.missing && date === DAY1)
    return local > '10:15' && local <= '10:20';
  // Late publication: 11:00–11:04 appear only from 15:35 on day 1.
  if (
    symbol === SYMBOLS.late &&
    date === DAY1 &&
    local > '11:00' &&
    local <= '11:05'
  )
    return fakeNow < kst(`${DAY1}T15:35:00`);
  return false;
}

function hhmmss(ms: number): string {
  return new Date(ms + 9 * 60 * MIN)
    .toISOString()
    .slice(11, 19)
    .replaceAll(':', '');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const query = Object.fromEntries(url.searchParams);
  requests.push({ path: url.pathname, query });
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-ratelimit-limit-day', '50000');
  res.setHeader('x-ratelimit-remaining-day', String(50000 - requests.length));
  if (url.pathname.endsWith('/lists')) {
    res.end(
      JSON.stringify({
        isuLists: url.pathname.includes('/kospi/')
          ? Object.values(SYMBOLS).map((isuSrtCd) => ({ isuSrtCd }))
          : [
              {
                isuSrtCd: url.pathname.includes('/kosdaq/')
                  ? '990001'
                  : '990002',
              },
            ],
      }),
    );
    return;
  }
  const parts = url.pathname.split('/');
  if (url.pathname.endsWith('/intraday')) {
    const symbol = parts[parts.length - 2];
    const date = query.inqStrtDd;
    const startMs = Date.parse(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${query.strtTm.slice(0, 2)}:${query.strtTm.slice(2)}:00+09:00`,
    );
    const endMs = Date.parse(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${query.endTm.slice(0, 2)}:${query.endTm.slice(2)}:00+09:00`,
    );
    const session = resolveMarketSession('KRX', date)!;
    const closeMs = session.closeTime.getTime();
    const auctionStart = closeMs - 10 * MIN;
    const priceAt = (open: number) => 70000 + ((open / MIN) % 7) * 10;
    // KOSCOM's shape (prod 10-16): flat zero-volume minutes through the
    // closing auction at the last continuous close, then the auction print
    // at the close — published minutes late (the 15:25 bucket was first
    // complete at 15:42 KST), so the close + delay tick misses it.
    const flatPrice = String(priceAt(auctionStart - MIN) + 10);
    const hisLists: Record<string, string>[] = [];
    for (let end = startMs + MIN; end <= endMs; end += MIN) {
      if (end > fakeNow || minuteHidden(symbol, end)) continue;
      const open = end - MIN;
      if (end === closeMs && fakeNow < closeMs + AUCTION_PUBLISH_DELAY_MS)
        continue;
      if (open < session.openTime.getTime() || end > closeMs) continue;
      if (open >= auctionStart && end !== closeMs) {
        hisLists.push({
          inddTm: `${hhmmss(end)}00`,
          inddOpnprc: flatPrice,
          inddHgprc: flatPrice,
          inddLwprc: flatPrice,
          inddClsprc: flatPrice,
          inddTrdvol: '0',
          inddTrdval: '0',
        });
        continue;
      }
      const price = priceAt(open);
      hisLists.push({
        inddTm: `${hhmmss(end)}00`,
        inddOpnprc: String(price),
        inddHgprc: String(price + 20),
        inddLwprc: String(price - 10),
        inddClsprc: String(price + 10),
        inddTrdvol: '100',
        inddTrdval: String(price * 100),
      });
    }
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        result: { isuSrtCd: symbol, trdDd: date, hisLists },
      }),
    );
    return;
  }
  if (url.pathname.endsWith('/history')) {
    const symbol = parts[parts.length - 2];
    const weekly = query.trnsmCycleTpCd === 'W';
    const hisLists: Record<string, string>[] = [];
    const from = query.inqStrtDd;
    const to = query.inqEndDd;
    const lastOfWeek = new Map<string, string>();
    for (
      let day = Date.parse(
        `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`,
      );
      day <=
      Date.parse(
        `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00Z`,
      );
      day += 24 * 60 * MIN
    ) {
      const compact = new Date(day)
        .toISOString()
        .slice(0, 10)
        .replaceAll('-', '');
      const session = resolveMarketSession('KRX', compact);
      if (!session) continue;
      // Today's daily bar is published 15 minutes after the close.
      if (session.closeTime.getTime() + 15 * MIN > fakeNow) continue;
      if (weekly) {
        const monday = new Date(
          day - ((new Date(day).getUTCDay() + 6) % 7) * 24 * 60 * MIN,
        )
          .toISOString()
          .slice(0, 10);
        lastOfWeek.set(monday, compact);
        continue;
      }
      hisLists.push({
        trdDd: compact,
        opnprc: '70000',
        hgprc: '70100',
        lwprc: '69900',
        trdPrc: '70050',
        accTrdvol: '1000',
        accTrdval: '70050000',
      });
    }
    if (weekly)
      for (const compact of lastOfWeek.values())
        hisLists.push({
          trdDd: compact,
          opnprc: '70000',
          hgprc: '70100',
          lwprc: '69900',
          trdPrc: '70050',
          accTrdvol: '5000',
          accTrdval: '350250000',
        });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        result: { isuSrtCd: symbol, hisLists },
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

// ---- wiring -------------------------------------------------------------------
const namespace = `krx-central-${randomUUID().slice(0, 8)}`;
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
const ingestion = new MarketCandleIngestionService(
  adapter,
  {} as never,
  new KisCandleNormalizerService(),
  new KisDomesticFiveMinuteBuilder(),
  repository,
  cache,
);
const sync = new MarketCandleSyncService(
  prisma,
  repository,
  states,
  backfillLocks,
  ingestion,
  adapter,
  {} as never,
  new KisPeriodCandleNormalizerService(),
  {} as never,
  readMarketCandleSyncConfig({}),
  cache,
);
const centralConfig = readKrxCentralCandlesConfig(
  { KOSCOM_CENTRAL_CANDLES_ENABLED: 'true' },
  COHORTS,
);
const central = new KrxCentralCandleService(
  prisma,
  sync,
  states,
  redis,
  centralConfig,
);
const compaction = new KrxCheckpointCompactionService(
  prisma,
  backfillLocks,
  centralConfig,
);
const servingConfig = readCandleServingConfig({});
const plans = new CandleReadPlanBuilder(servingConfig);
const loader = new CandleDatabaseLoader(
  plans,
  repository,
  states,
  new MarketCandleAggregationService(repository),
  new CandleResponseBuilder(),
  servingConfig,
  centralConfig,
);

const assetIds = new Map<string, string>();
const warnings: string[] = [];

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
        name: `KRX central ${key}`,
        market: 'KOSPI',
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
  if (ids.length) {
    await prisma.marketCandle.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.marketCandleSyncState.deleteMany({
      where: { assetId: { in: ids } },
    });
    await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  }
}

function setNow(ms: number) {
  fakeNow = ms;
  mock.timers.setTime(ms);
}

async function slotState(symbol: string, session: typeof day1, nowMs: number) {
  const id = assetIds.get(symbol)!;
  const startMs = Date.parse(
    COHORTS.find((cohort) => cohort.symbols.includes(symbol))!.obligationStart,
  );
  const rows = await states.findCheckpointsOverlapping(
    id,
    '5m',
    session.openTime,
    session.closeTime,
    new Date(startMs),
  );
  return krxSessionSlotState({
    session,
    nowMs,
    rows,
    obligationStartMs: startMs,
  });
}

function categoryOf(entry: { path: string; query: Record<string, string> }) {
  if (entry.path.endsWith('/lists')) return 'lists';
  if (entry.path.endsWith('/intraday')) return 'intraday';
  return entry.query.trnsmCycleTpCd === 'W' ? 'weekly' : 'daily';
}

function countRequests(from: number, to: number, category: string) {
  return requests
    .slice(from, to)
    .filter((entry) => categoryOf(entry) === category).length;
}

async function runSessionTicks(session: typeof day1) {
  for (const tick of krxIntradayTickTimes(session, centralConfig.tickDelayMs)) {
    setNow(tick);
    await central.runIntradayTick({ now: new Date(tick) });
    if (tick === kst(`${session.localDate}T12:56:10`)) {
      // Crash injection: a run 20 s later died and left its row running;
      // the next tick must supersede it (restart path).
      setNow(tick + 20_000);
      await states.createRunning({
        assetId: assetIds.get(SYMBOLS.clean)!,
        feed: '5m',
        sourceProvider: KOSCOM_MINUTE_SOURCE,
        mode: MarketCandleSyncMode.repair,
        targetFrom: new Date(kst(`${session.localDate}T12:55:00`)),
        targetTo: new Date(kst(`${session.localDate}T13:00:00`)),
      });
    }
  }
}

async function main() {
  const originalWarn = console.warn;
  mock.timers.enable({ apis: ['Date'], now: fakeNow });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  fixtureBaseUrl = `http://127.0.0.1:${address.port}`;
  const loggerWarn = (message: unknown) => warnings.push(String(message));
  // Nest Logger output goes through console; keep alert lines for assertions.
  console.warn = (...args: unknown[]) => loggerWarn(args.join(' '));
  process.stdout.write = (
    (write) =>
    (chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      if (text.includes('krx_central_') || text.includes('krx_checkpoint_'))
        warnings.push(text);
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }
  )(process.stdout.write.bind(process.stdout)) as typeof process.stdout.write;
  await prisma.$connect();
  try {
    await createAssets();
    const start = requests.length;

    // ---- day 1 intraday ----------------------------------------------------
    await runSessionTicks(day1);
    const ticksDay1 = krxIntradayTickTimes(
      day1,
      centralConfig.tickDelayMs,
    ).length;
    const intradayDay1 = countRequests(start, requests.length, 'intraday');
    // Cohort-2 owes nothing before its A: three obligated assets per tick.
    assert.equal(
      intradayDay1,
      3 * ticksDay1,
      'one minute request per obligated asset per tick',
    );

    const afterTicks = day1.closeTime.getTime() + 2 * MIN;
    const clean = await slotState(SYMBOLS.clean, day1, afterTicks);
    assert.equal(
      clean.unproven.length,
      0,
      'clean asset fully proven (crash injection superseded)',
    );
    const missing = await slotState(SYMBOLS.missing, day1, afterTicks);
    assert.deepEqual(
      missing.held,
      [kst(`${DAY1}T10:15:00`)],
      'missing bucket held after two audited misses',
    );
    assert.deepEqual(
      missing.unproven,
      [kst(`${DAY1}T10:15:00`)],
      'only the missing bucket is unproven',
    );
    const late = await slotState(SYMBOLS.late, day1, afterTicks);
    assert.deepEqual(
      late.unproven,
      [kst(`${DAY1}T11:00:00`)],
      'late bucket unproven before repair',
    );
    const superseded = await prisma.marketCandleSyncState.count({
      where: { assetId: assetIds.get(SYMBOLS.clean), errorCode: 'SUPERSEDED' },
    });
    assert.equal(
      superseded,
      1,
      'the crashed running row was superseded by the next tick',
    );

    // Closing-price evidence: the late auction print missed the last tick.
    const auctionBuckets = (symbol: string) =>
      prisma.marketCandle.count({
        where: {
          assetId: assetIds.get(symbol)!,
          interval: '5m',
          isClosed: true,
          sourceProvider: KOSCOM_MINUTE_SOURCE,
          openTime: {
            gte: new Date(day1.closeTime.getTime() - 10 * MIN),
            lt: day1.closeTime,
          },
        },
      });
    assert.equal(
      await auctionBuckets(SYMBOLS.clean),
      1,
      'only the flat 15:20 bucket before the auction print is published',
    );

    // ---- day 1 post-close: repair, daily, repair, daily --------------------
    const beforeRepair = requests.length;
    setNow(day1.closeTime.getTime() + 10 * MIN);
    await central.runRepair({ now: new Date(fakeNow) });
    setNow(day1.closeTime.getTime() + 20 * MIN);
    await central.runDaily({ now: new Date(fakeNow) });
    setNow(day1.closeTime.getTime() + 40 * MIN);
    await central.runRepair({ now: new Date(fakeNow) });
    const repairRequests = countRequests(
      beforeRepair,
      requests.length,
      'intraday',
    );
    const lateAfter = await slotState(SYMBOLS.late, day1, fakeNow);
    assert.equal(
      lateAfter.unproven.length,
      0,
      'late minutes repaired after the close (no gap left)',
    );
    const missingAfter = await slotState(SYMBOLS.missing, day1, fakeNow);
    assert.deepEqual(
      missingAfter.unproven,
      [kst(`${DAY1}T10:15:00`)],
      'a truly missing bucket stays a visible gap',
    );
    const repairRows = await prisma.marketCandleSyncState.findMany({
      where: {
        assetId: assetIds.get(SYMBOLS.missing),
        createdAt: { gte: day1.closeTime },
      },
      select: { cursorJson: true },
    });
    const missingRepairs = repairRows.filter((row) => {
      const cursor = row.cursorJson as Record<string, unknown> | null;
      return cursor?.auditPhase === 'repair' && 'auditFirstMissing' in cursor;
    }).length;
    assert.ok(missingRepairs <= 3, 'at most 3 repair calls for one asset');
    // late slot + missing slot (2 attempts) + one auction request per asset.
    assert.equal(
      repairRequests,
      1 + 2 + 3,
      'repair requests stay inside the caps',
    );
    for (const symbol of [SYMBOLS.clean, SYMBOLS.missing, SYMBOLS.late])
      assert.equal(
        await auctionBuckets(symbol),
        2,
        `closing-auction buckets stored by the post-close repair (${symbol})`,
      );
    assert.ok(
      !warnings.some((line) =>
        line.includes('krx_central_closing_auction_missing'),
      ),
      'no closing-auction alert once the print is stored',
    );
    assert.ok(
      warnings.some(
        (line) =>
          line.includes('krx_central_slots_unproven_after_repair') &&
          line.includes(SYMBOLS.missing),
      ),
      'the remaining gap is alerted',
    );

    // Daily: confirmed once published (15:45); a second run makes no call.
    const daily1 = await states.findCandleCoverage(
      assetIds.get(SYMBOLS.clean)!,
      '1d',
      new Date(kst(`${DAY1}T00:00:00`)),
      new Date(fakeNow),
    );
    assert.ok(
      daily1.contiguousCoveredTo &&
        daily1.contiguousCoveredTo.getTime() >= fakeNow - 20 * MIN,
      "today's daily bar confirmed",
    );
    const beforeSecondDaily = requests.length;
    setNow(day1.closeTime.getTime() + 60 * MIN);
    await central.runDaily({ now: new Date(fakeNow) });
    assert.equal(
      countRequests(beforeSecondDaily, requests.length, 'daily'),
      0,
      'confirmed daily bars are not re-fetched',
    );

    // ---- day 2 05:00: compaction keeps every reader result -----------------
    setNow(kst(`${DAY2}T05:00:00`));
    const windows: [number, number][] = [
      [kst(`${DAY1}T09:00:00`), kst(`${DAY1}T15:30:00`)],
      [kst(`${DAY1}T10:00:00`), kst(`${DAY1}T12:00:00`)],
      [kst(`${DAY1}T08:00:00`), kst(`${DAY2}T05:00:00`)],
    ];
    const readAll = async () => {
      const out: string[] = [];
      for (const symbol of [SYMBOLS.clean, SYMBOLS.missing, SYMBOLS.late])
        for (const [from, to] of windows) {
          const coverage = await states.findCandleCoverage(
            assetIds.get(symbol)!,
            '5m',
            new Date(from),
            new Date(to),
            {
              bridge: krxFiveMinuteBridge(fakeNow),
              createdAtOrAfter: new Date(COHORTS[0].obligationStart),
            },
          );
          out.push(
            JSON.stringify([
              coverage.startsAtRequestedFrom,
              coverage.contiguousCoveredTo?.getTime() ?? null,
              coverage.hasInteriorGap,
            ]),
          );
        }
      return out.join('\n');
    };
    const rowsBefore = await prisma.marketCandleSyncState.count({
      where: { assetId: { in: [...assetIds.values()] } },
    });
    const before = await readAll();
    const summary = await compaction.run({ now: new Date(fakeNow) });
    const after = await readAll();
    const rowsAfter = await prisma.marketCandleSyncState.count({
      where: { assetId: { in: [...assetIds.values()] } },
    });
    assert.equal(
      after,
      before,
      'compaction leaves the coverage reader unchanged',
    );
    assert.ok(
      rowsAfter < rowsBefore / 5,
      `compaction shrinks checkpoints (${rowsBefore} → ${rowsAfter})`,
    );
    assert.equal(summary.seriesSkipped.length, 0, 'no series skipped');

    // ---- day 2: cohort 2 starts; weekly on the week's last session ---------
    const startDay2 = requests.length;
    await runSessionTicks(day2);
    const ticksDay2 = krxIntradayTickTimes(
      day2,
      centralConfig.tickDelayMs,
    ).length;
    assert.equal(
      countRequests(startDay2, requests.length, 'intraday'),
      4 * ticksDay2,
      'cohort 2 collected from its A',
    );
    setNow(day2.closeTime.getTime() + 20 * MIN);
    const beforeWeekly = requests.length;
    await central.runDaily({ now: new Date(fakeNow) });
    assert.equal(
      countRequests(beforeWeekly, requests.length, 'weekly'),
      4,
      'one weekly request per asset on Friday',
    );

    // ---- obligation classification + KRX DB-only serving (L3) --------------
    const query = (): ParsedAssetCandlesQuery => ({
      range: 'prev24_open',
      rangeProvided: true,
      rangeStartAt: new Date(kst('2026-09-30T09:00:00')),
      rangeEndAt: new Date(fakeNow),
      interval: '1h',
      intervalMinutes: 60,
      limit: 336,
      requestedDate: DAY2,
      toHHmmss: '160000',
      toInstant: new Date(fakeNow),
      dateProvided: true,
      toProvided: true,
      includePrevious: true,
      explicitDate: false,
      explicitTo: false,
      clock: new Date(fakeNow),
    });
    const assetRecord = async (symbol: string) => {
      const row = await prisma.asset.findUniqueOrThrow({
        where: { id: assetIds.get(symbol)! },
      });
      return {
        id: row.id,
        symbol: row.symbol,
        name: row.name,
        market: row.market,
        assetType: row.assetType,
        currencyCode: row.currencyCode,
        priceCurrency: row.priceCurrency ?? row.currencyCode,
        settlementCurrency: row.settlementCurrency ?? row.currencyCode,
        isActive: row.isActive,
      };
    };
    const newcomer = await loader.load(
      await assetRecord(SYMBOLS.cohort2),
      query(),
    );
    assert.equal(
      newcomer.obligation,
      'pre_obligation',
      'new cohort: initial history, not a defect',
    );
    const defect = await loader.load(
      await assetRecord(SYMBOLS.missing),
      query(),
    );
    assert.equal(
      defect.obligation,
      'post_obligation',
      'held bucket after A is a collection defect',
    );

    const before3 = await budget.readQuotaDay(namespace, new Date(fakeNow));
    const serving = new CandleServingService(
      plans,
      loader,
      cache,
      {
        getOrLoad: ({ loader: load }: { loader: () => Promise<unknown> }) =>
          load(),
      } as never,
      {
        syncAsset: () =>
          Promise.reject(new Error('KRX chart read must never sync')),
      } as never,
      servingConfig,
      undefined,
      centralConfig,
    );
    const requestsBeforeReads = requests.length;
    for (let reader = 0; reader < 50; reader++)
      await serving.serve(await assetRecord(SYMBOLS.clean), query(), () =>
        Promise.reject(
          new Error('KRX chart read must never call the provider'),
        ),
      );
    assert.equal(
      requests.length,
      requestsBeforeReads,
      'KRX chart reads make no provider call',
    );
    const after3 = await budget.readQuotaDay(namespace, new Date(fakeNow));
    assert.equal(
      after3.counts.user_request - before3.counts.user_request,
      0,
      'no user_request attempt counted',
    );

    // ---- counters vs provider log (attempts, per category) -----------------
    await new Promise((resolve) => setTimeout(resolve, 200)); // fire-and-forget counters
    const day2Counts = await budget.readQuotaDay(namespace, new Date(fakeNow));
    const day1Counts = await budget.readQuotaDay(
      namespace,
      new Date(kst(`${DAY1}T16:00:00`)),
    );
    const total = day1Counts.counts.total + day2Counts.counts.total;
    assert.equal(
      total,
      requests.length,
      'every provider request was counted exactly once',
    );
    const minuteTotal =
      day1Counts.counts.minute +
      day2Counts.counts.minute +
      day1Counts.counts.gap_repair +
      day2Counts.counts.gap_repair;
    assert.equal(
      minuteTotal,
      requests.filter((entry) => categoryOf(entry) === 'intraday').length,
      'minute + gap_repair = intraday requests',
    );
    assert.equal(
      day1Counts.counts.lists + day2Counts.counts.lists,
      requests.filter((entry) => categoryOf(entry) === 'lists').length,
      'market lists are counted as P1 lists even inside a minute context',
    );
    assert.ok(
      day2Counts.headerRemainingMin !== null,
      'the remaining-quota header is recorded',
    );

    // ---- G4-I / G4-H read-only expansion gates (stage 5) ---------------------
    const fixtureIds = [...assetIds.values()];
    const gates = new KrxCollectionGateDiagnostics(
      prisma,
      states,
      centralConfig,
    );
    const g4i = await gates.g4i({
      now: new Date(fakeNow),
      sessions: 3,
      assetIds: fixtureIds,
    });
    // Day 2's repair window is not over yet: day 1 is the newest gated session.
    assert.equal(
      g4i.sessions[0],
      DAY1,
      'G4-I gates sessions whose repair is over',
    );
    assert.equal(
      g4i.totals.obligated,
      3 * 76,
      'cohort-1 stocks x 76 required slots',
    );
    assert.equal(g4i.totals.concealed, 0, 'G4-I: no concealed slot');
    assert.equal(
      g4i.totals.held,
      1,
      'G4-I: the missing bucket is an alerted hold',
    );
    assert.equal(g4i.pass.defectRateWithin, false, '1 / 228 exceeds 0.1 %');
    assert.equal(g4i.pass.measured, true, 'G4-I measured recorded slots');
    assert.equal(
      g4i.pass.collectionStartedInTime,
      true,
      'first checkpoint within the first tick after A',
    );
    const g4h = await gates.g4h({
      now: new Date(fakeNow),
      assetIds: fixtureIds,
    });
    const newcomerH = g4h.find((entry) => entry.symbol === SYMBOLS.cohort2)!;
    assert.equal(
      newcomerH.intraday[0].state,
      'pre_obligation',
      'cohort 2 5m window is initial history',
    );
    assert.equal(
      newcomerH.intraday[0].readyFrom,
      '2026-10-21',
      'ready from the 3rd session after A',
    );
    assert.equal(
      newcomerH.daily.state,
      'incomplete',
      'no 576-session daily backfill in the fixture',
    );
    const daily = newcomerH.daily;
    assert.ok(
      daily.confirmed > 0 && daily.missing.count > 0,
      "the central job's own bars are confirmed; older sessions are missing",
    );
    assert.equal(
      daily.unconfirmed.count + daily.unexpected.count,
      0,
      'bars the central writer stored meet the daily audit rule',
    );
    assert.equal(
      daily.confirmed + daily.missing.count,
      daily.sessionsExpected,
      'every closed session is either confirmed or missing',
    );
    assert.equal(
      newcomerH.fourHour.state,
      'incomplete',
      'no 4h long sync in the fixture',
    );
    assert.equal(
      newcomerH.fourHour.missing.count,
      newcomerH.fourHour.sessionsExpected,
      'every 4h session is missing (none stored, none held)',
    );

    console.log(
      `krx central candles integration ok: ${requests.length} provider requests, ` +
        `${ticksDay1 + ticksDay2} ticks, compaction ${rowsBefore}→${rowsAfter} rows, repair requests ${repairRequests}, ` +
        `G4-I obligated ${g4i.totals.obligated} held ${g4i.totals.held} concealed ${g4i.totals.concealed}`,
    );
  } finally {
    console.warn = originalWarn;
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
