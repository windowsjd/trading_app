/**
 * Real PostgreSQL check of the market_candles upsert guard (P1, 2026-10-16):
 * an unchanged closed bar that was already confirmed after its close is not
 * rewritten, while every write that carries information still lands — the
 * first confirmation after the close, provider corrections, provider changes,
 * open bars, the open → closed transition — and the existing ordering and
 * legacy-KIS fences are unchanged. A tuple that is not rewritten keeps its
 * xmin. Disposable local *_test database only; cleans up its own rows.
 *
 *   MARKET_CANDLE_UPSERT_DB_INTEGRATION=1 DATABASE_URL=<local *_test> \
 *   pnpm tsx scripts/market-candle-upsert-guard-integration.ts
 */
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { MarketCandlesRepository } from '../src/assets/market-candles.repository';
import { DailyChangeRateService } from '../src/assets/daily-change-rate.service';

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.ok(
  ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.pathname.endsWith('_test'),
  'Use a disposable local *_test PostgreSQL database.',
);
assert.equal(process.env.MARKET_CANDLE_UPSERT_DB_INTEGRATION, '1');

const prisma = new PrismaService();
const repository = new MarketCandlesRepository(prisma);
const MIN = 60_000;
const assetIds: string[] = [];

async function main() {
  await prisma.$connect();
  const crypto = await prisma.asset.create({
    data: {
      symbol: `UPG${randomInt(100000, 999999)}USDT`,
      name: 'upsert guard crypto fixture',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      isActive: false,
    },
  });
  assetIds.push(crypto.id);
  const openTime = new Date('2026-09-01T00:00:00Z');
  const closeTime = new Date(+openTime + 5 * MIN);
  const bar = (over: Record<string, unknown> = {}) => ({
    assetId: crypto.id,
    interval: '5m' as const,
    openTime,
    closeTime,
    open: '100',
    high: '110',
    low: '95',
    close: '105.5',
    volume: '12.25',
    amount: '1300',
    isClosed: true,
    sourceProvider: 'binance_spot_ws_5m_kline',
    sourceUpdatedAt: new Date(+closeTime - 1),
    ...over,
  });
  const stored = async () => {
    const [row] = await prisma.$queryRaw<
      Array<{
        xmin: string;
        close: string;
        source_provider: string;
        source_updated_at: Date;
        updated_at: Date;
        is_closed: boolean;
      }>
    >`SELECT xmin::text AS xmin, close::text AS close, source_provider,
        source_updated_at, updated_at, is_closed
      FROM market_candles
      WHERE asset_id = ${crypto.id} AND interval = '5m' AND open_time = ${openTime}`;
    return row;
  };
  const write = async (over: Record<string, unknown>) =>
    (await repository.upsertMany([bar(over)])).writtenCount;

  // A live row finalized at the close (provider event time) is stored.
  assert.equal(await write({}), 1);
  // The first REST confirmation with identical values still lands: it moves
  // source_updated_at past the close for daily evidence and re-confirm logic.
  assert.equal(
    await write({
      sourceProvider: 'binance_klines',
      sourceUpdatedAt: new Date(+closeTime + 10_000),
    }),
    1,
  );
  // Still inside the 2-minute re-confirm grace: identical values land again.
  assert.equal(
    await write({
      sourceProvider: 'binance_klines',
      sourceUpdatedAt: new Date(+closeTime + 3 * MIN),
    }),
    1,
  );
  const confirmed = await stored();
  assert.equal(
    confirmed.source_updated_at.toISOString(),
    new Date(+closeTime + 3 * MIN).toISOString(),
  );
  // Confirmed after its close and unchanged: every later identical fetch is
  // left alone — same tuple (xmin), same confirmation and updated_at.
  for (const minutes of [10, 60, 24 * 60]) {
    assert.equal(
      await write({
        sourceProvider: 'binance_klines',
        sourceUpdatedAt: new Date(+closeTime + minutes * MIN),
      }),
      0,
    );
  }
  // Numeric scale is not a change.
  assert.equal(
    await write({
      sourceProvider: 'binance_klines',
      close: '105.50000000',
      volume: '12.250',
      sourceUpdatedAt: new Date(+closeTime + 25 * 60 * MIN),
    }),
    0,
  );
  const untouched = await stored();
  assert.equal(untouched.xmin, confirmed.xmin);
  assert.equal(+untouched.updated_at, +confirmed.updated_at);
  assert.equal(+untouched.source_updated_at, +confirmed.source_updated_at);
  // A provider correction of a closed bar always lands.
  assert.equal(
    await write({
      sourceProvider: 'binance_klines',
      close: '105.6',
      sourceUpdatedAt: new Date(+closeTime + 26 * 60 * MIN),
    }),
    1,
  );
  assert.equal((await stored()).close, '105.60000000');
  // A provider change with identical values lands (provenance changes).
  assert.equal(
    await write({
      close: '105.6',
      sourceProvider: 'binance_spot_ws_5m_kline',
      sourceUpdatedAt: new Date(+closeTime + 27 * 60 * MIN),
    }),
    1,
  );
  // The existing ordering fence: an older observation never overwrites.
  assert.equal(
    await write({
      close: '96',
      sourceProvider: 'binance_klines',
      sourceUpdatedAt: new Date(+closeTime + 1),
    }),
    0,
  );
  assert.equal((await stored()).close, '105.60000000');

  // Open bars keep updating even when unchanged (freshness of the current
  // bar), and the open → closed transition always lands.
  const current = new Date('2026-09-01T00:05:00Z');
  const open = (over: Record<string, unknown>) =>
    bar({
      openTime: current,
      closeTime: new Date(+current + 5 * MIN),
      isClosed: false,
      sourceProvider: 'binance_klines',
      ...over,
    });
  assert.equal(
    (
      await repository.upsertMany([
        open({ sourceUpdatedAt: new Date(+current + MIN) }),
      ])
    ).writtenCount,
    1,
  );
  assert.equal(
    (
      await repository.upsertMany([
        open({ sourceUpdatedAt: new Date(+current + 2 * MIN) }),
      ])
    ).writtenCount,
    1,
  );
  assert.equal(
    (
      await repository.upsertMany([
        open({
          isClosed: true,
          sourceUpdatedAt: new Date(+current + 5 * MIN + 1),
        }),
      ])
    ).writtenCount,
    1,
  );

  // Legacy KIS closed rows keep their fence against KOSCOM rewrites.
  const krx = await prisma.asset.create({
    data: {
      symbol: String(randomInt(800000, 899999)),
      name: 'upsert guard KRX fixture',
      market: 'KRX',
      assetType: 'domestic_stock',
      currencyCode: 'KRW',
      isActive: false,
    },
  });
  assetIds.push(krx.id);
  const krxOpen = new Date('2026-09-01T00:00:00Z');
  const krxBar = (over: Record<string, unknown>) => ({
    assetId: krx.id,
    interval: '5m' as const,
    openTime: krxOpen,
    closeTime: new Date(+krxOpen + 5 * MIN),
    open: '70000',
    high: '70500',
    low: '69900',
    close: '70100',
    volume: '1000',
    amount: '70100000',
    isClosed: true,
    sourceProvider: 'kis_domestic_minute',
    sourceUpdatedAt: new Date(+krxOpen + 10 * MIN),
    ...over,
  });
  await repository.upsertMany([
    krxBar({ sourceProvider: 'kis_domestic_minute' }),
  ]);
  assert.equal(
    (
      await repository.upsertMany([
        krxBar({
          sourceProvider: 'koscom_intraday',
          close: '70200',
          sourceUpdatedAt: new Date(+krxOpen + 60 * MIN),
        }),
      ])
    ).writtenCount,
    0,
  );

  // A daily bar confirmed after its close stays usable as the change-rate
  // baseline although later identical fetches no longer rewrite it.
  const dayOpen = new Date('2026-09-01T00:00:00Z');
  const dayClose = new Date('2026-09-02T00:00:00Z');
  const daily = (sourceUpdatedAt: Date) => ({
    assetId: crypto.id,
    interval: '1d' as const,
    openTime: dayOpen,
    closeTime: dayClose,
    open: '100',
    high: '110',
    low: '95',
    close: '100',
    volume: '10',
    amount: '1000',
    isClosed: true,
    sourceProvider: 'binance_klines',
    sourceUpdatedAt,
  });
  await repository.upsertMany([daily(new Date(+dayClose + 5 * MIN))]);
  assert.equal(
    (await repository.upsertMany([daily(new Date(+dayClose + 60 * MIN))]))
      .writtenCount,
    0,
  );
  const rate = await new DailyChangeRateService(repository).calculate({
    asset: {
      id: crypto.id,
      assetType: 'crypto',
      market: 'BINANCE',
    } as never,
    price: '110',
    effectiveAt: new Date(+dayClose + 2 * 3600000),
    now: new Date(+dayClose + 3 * 3600000),
  });
  assert.equal(rate, '10.00000000');
  console.log('market candle upsert guard PostgreSQL ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (assetIds.length) {
      await prisma.marketCandle.deleteMany({
        where: { assetId: { in: assetIds } },
      });
      await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
    }
    await prisma.$disconnect();
  });
