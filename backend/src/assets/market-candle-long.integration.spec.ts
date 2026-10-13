import { spawnSync } from 'node:child_process';

// Opt-in PostgreSQL smoke for the long-range 4h storage (2026-10-13):
// MARKET_CANDLE_LONG_DB_SMOKE=1 and a disposable `*_test` DATABASE_URL.
const itDb = process.env.MARKET_CANDLE_LONG_DB_SMOKE === '1' ? it : it.skip;

describe('Long-range 4h candle storage PostgreSQL smoke', () => {
  itDb(
    'keeps Spot and USDⓈ-M 4h rows of the same symbol/time apart, resumes KRX sync and prunes 180-day history',
    () => {
      const prepare = spawnSync(pnpm(), ['run', 'test:db:prepare'], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (prepare.status !== 0) {
        throw new Error(`Long candle migrate deploy failed:\n${prepare.stderr}`);
      }
      const result = spawnSync(pnpm(), ['exec', 'tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `Long candle DB smoke failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stdout).toContain('long candle db smoke ok');
    },
    260_000,
  );
});

function pnpm(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

const RUNNER = String.raw`
import 'dotenv/config';
import assert from 'node:assert/strict';
import { PrismaService } from './src/prisma/prisma.service';
import { MarketCandlesRepository } from './src/assets/market-candles.repository';
import {
  FuturesMarketCandlesRepository,
  FuturesMarketCandleValidationError,
} from './src/assets/market-candle-futures.repository';
import { FuturesCandlesService } from './src/assets/market-candle-futures.service';
import { MarketCandleRetentionService } from './src/assets/market-candle-retention.service';
import { MarketCandleLongSyncService } from './src/assets/market-candle-long-sync.service';
import { resolveMarketSession } from './src/orders/market-calendar.policy';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/_test$/.test(url.pathname.slice(1)) || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
  throw new Error('Requires a local disposable *_test DATABASE_URL.');
}
const prisma = new PrismaService();
const spot = new MarketCandlesRepository(prisma);
const futures = new FuturesMarketCandlesRepository(prisma);
const H4 = 4 * 3600_000;
const tag = String(Date.now()).slice(-8);
const created: { assets: string[]; instruments: string[] } = { assets: [], instruments: [] };

async function main() {
  // BTCUSDT: one Spot underlying shared by its USDⓈ-M instrument (20 of the
  // 25 catalog contracts work this way). Reuse rows when the DB is seeded.
  const sym = 'BTCUSDT';
  let underlying = await prisma.asset.findUnique({ where: { market_symbol: { market: 'BINANCE', symbol: sym } } });
  if (!underlying) {
    underlying = await prisma.asset.create({ data: {
      symbol: sym, name: 'Bitcoin', market: 'BINANCE',
      currencyCode: 'USD', priceCurrency: 'USD', settlementCurrency: 'USD', assetType: 'crypto',
    } });
    created.assets.push(underlying.id);
  }
  let instrument = await prisma.futuresInstrument.findFirst({ where: { underlyingAssetId: underlying.id } });
  if (!instrument) {
    instrument = await prisma.futuresInstrument.create({ data: {
      underlyingAssetId: underlying.id, productType: 'synthetic_perpetual', settlementCurrency: 'USD',
      markContractJson: { priceTickSize: '0.10' },
    } });
    created.instruments.push(instrument.id);
  }
  const btc = underlying;
  const open = new Date('2026-10-13T00:00:00.000Z');
  const updated = new Date('2026-10-13T04:01:00.000Z');
  // Same series time, two markets, different prices — no overwrite either way.
  await spot.upsertMany([{ assetId: underlying.id, interval: '4h', openTime: open,
    closeTime: new Date(open.getTime() + H4), open: '100', high: '110', low: '90', close: '105',
    volume: '1', amount: '100', isClosed: true, sourceProvider: 'binance_klines', sourceUpdatedAt: updated }]);
  await futures.upsertMany([{ futuresInstrumentId: instrument.id, interval: '4h', contractSymbol: sym,
    openTime: open, closeTime: new Date(open.getTime() + H4), open: '101', high: '111', low: '91',
    close: '106', volume: '2', amount: '200', isClosed: true, sourceUpdatedAt: updated }]);
  const spotRows = await spot.findRange({ assetId: underlying.id, interval: '4h', from: open, to: new Date(open.getTime() + H4) });
  const futRows = await futures.findRange({ futuresInstrumentId: instrument.id, interval: '4h', from: open, to: new Date(open.getTime() + H4) });
  assert.equal(spotRows.length, 1);
  assert.equal(futRows.length, 1);
  assert.equal(spotRows[0].close.toString(), '105');
  assert.equal(futRows[0].close.toString(), '106');

  // Idempotent re-upsert; an in-progress version never downgrades a closed row.
  await futures.upsertMany([{ futuresInstrumentId: instrument.id, interval: '4h', contractSymbol: sym,
    openTime: open, closeTime: new Date(open.getTime() + H4), open: '1', high: '1', low: '1',
    close: '1', volume: '0', amount: '0', isClosed: false, sourceUpdatedAt: new Date(updated.getTime() + 60_000) }]);
  const after = await futures.findRange({ futuresInstrumentId: instrument.id, interval: '4h', from: open, to: new Date(open.getTime() + H4) });
  assert.equal(after.length, 1);
  assert.equal(after[0].isClosed, true);
  assert.equal(after[0].close.toString(), '106');

  // Identity trigger: another contract's symbol cannot attach to this instrument.
  await assert.rejects(
    futures.upsertMany([{ futuresInstrumentId: instrument.id, interval: '4h', contractSymbol: 'ETHUSDT',
      openTime: new Date(open.getTime() + H4), closeTime: new Date(open.getTime() + 2 * H4), open: '1', high: '1',
      low: '1', close: '1', volume: '0', isClosed: true, sourceUpdatedAt: updated }]),
    FuturesMarketCandleValidationError,
  );
  // DB allowlists: 4h is a stored market_candles interval, 15m still is not.
  await assert.rejects(prisma.$executeRawUnsafe(
    'INSERT INTO market_candles (id, asset_id, interval, open_time, close_time, open, high, low, close, volume, is_closed, source_provider, source_updated_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 1, 1, 1, 0, true, $6, $4, now())',
    'smoke-' + tag, underlying.id, '15m', open, new Date(open.getTime() + 900_000), 'binance_klines'));

  // Futures chart read: DB only, contract rows only, provisional current bucket.
  const now = new Date(open.getTime() + H4 + 30 * 60_000);
  await futures.upsertMany([{ futuresInstrumentId: instrument.id, interval: '4h', contractSymbol: sym,
    openTime: new Date(open.getTime() + H4), closeTime: new Date(open.getTime() + 2 * H4), open: '106',
    high: '107', low: '105', close: '106.5', volume: '1', amount: '106', isClosed: false, sourceUpdatedAt: now }]);
  const chart = await new FuturesCandlesService(prisma, futures).getInstrumentCandles('smoke-user', instrument.id, {}, now);
  const inWindow = chart.data.candles.filter((c) => Date.parse(c.time) >= open.getTime());
  assert.deepEqual(inWindow.map((c) => [c.time, c.provisional, c.close]), [
    [open.toISOString(), false, '106.00000000'],
    [new Date(open.getTime() + H4).toISOString(), true, '106.50000000'],
  ]);
  assert.equal(chart.data.priceBasis, 'contract_last_trade');
  // The Spot chart store still holds only the Spot row for the same time.
  const spotSame = await spot.findRange({ assetId: underlying.id, interval: '4h', from: open, to: new Date(open.getTime() + 2 * H4) });
  assert.deepEqual(spotSame.map((row) => row.close.toString()), ['105']);

  // KRX: verified 10-minute sessions land as koscom_history_10m 4h rows, and a
  // rerun only fetches what is still missing.
  const krx = await prisma.asset.create({ data: {
    symbol: '9' + tag.slice(-5), name: 'KRX smoke', market: 'KRX',
    currencyCode: 'KRW', priceCurrency: 'KRW', settlementCurrency: 'KRW', assetType: 'domestic_stock',
  } });
  created.assets.push(krx.id);
  const rowsFor = (date: string) => {
    const session = resolveMarketSession('KRX', date)!;
    const rows = [];
    let i = 0;
    for (let label = session.openTime.getTime() + 600_000; label <= session.closeTime.getTime(); label += 600_000) {
      const auction = label === session.closeTime.getTime();
      // Prices differ per date: identical adjacent sessions are held by design.
      const p = 50000 + (Number(date.slice(4)) % 97) * 100 + i;
      rows.push({ label: new Date(label), open: String(p), high: String(auction ? p : p + 2),
        low: String(auction ? p : p - 2), close: String(auction ? p : p + 1), volume: '5', amount: String(5 * p) });
      i += 1;
    }
    return rows;
  };
  let tenMinuteCalls = 0;
  const adapter = {
    fetchPeriodPage: async (input: { fromDate: string; endDate: string }) => {
      const rows = [];
      for (let ms = Date.UTC(+input.fromDate.slice(0, 4), +input.fromDate.slice(4, 6) - 1, +input.fromDate.slice(6, 8)); ; ms += 86_400_000) {
        const date = new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
        if (date > input.endDate) break;
        if (!resolveMarketSession('KRX', date)) continue;
        const r = rowsFor(date);
        rows.push({ value: { stck_bsop_date: date, stck_oprc: r[0].open,
          stck_hgpr: String(Math.max(...r.map((x) => +x.high))), stck_lwpr: String(Math.min(...r.map((x) => +x.low))),
          stck_clpr: r[r.length - 1].close, acml_vol: '999', acml_tr_pbmn: '1' }, receivedAt: new Date(), sequence: 0 });
      }
      return { state: 'ok', rows, providerReturnedRows: rows.length };
    },
    fetchDomesticTenMinuteSession: async (input: { date: string }) => {
      tenMinuteCalls += 1;
      return { rows: rowsFor(input.date), invalidRows: 0, providerReturnedRows: 39, receivedAt: new Date() };
    },
  };
  const locks = { acquire: async () => ({ acquired: true, handle: {} }), renewIfDue: async () => true, release: async () => true };
  const cache = { invalidateAsset: async () => ({ status: 'ok' }) };
  const sync = new MarketCandleLongSyncService(prisma, spot, futures, locks as never, cache as never,
    {} as never, {} as never, adapter as never, { getLastObservedRateLimit: () => null } as never);
  const at = new Date('2026-10-12T07:20:00.000Z');
  const first = await sync.syncKrx({ mode: 'backfill', now: at, sessions: 5, assetIds: [krx.id], krx: { minCallIntervalMs: 0, maxCalls: 3 } });
  assert.equal(first.stopReason, 'call_cap');
  assert.equal(first.series[0].rowsWritten, 4);
  const second = await sync.syncKrx({ mode: 'backfill', now: at, sessions: 5, assetIds: [krx.id], krx: { minCallIntervalMs: 0 } });
  assert.equal(second.series[0].missingBefore, 3);
  assert.equal(second.series[0].status, 'synced');
  assert.equal(tenMinuteCalls, 5);
  const stored = await prisma.marketCandle.findMany({ where: { assetId: krx.id, interval: '4h' } });
  assert.equal(stored.length, 10);
  assert.ok(stored.every((row) => row.sourceProvider === 'koscom_history_10m' && row.isClosed));

  // Retention: 4h history keeps its own 180-day cutoff; 1d is never pruned.
  const runAt = new Date('2026-10-13T00:00:00.000Z');
  const old = new Date(runAt.getTime() - 200 * 86_400_000);
  const recent = new Date(runAt.getTime() - 100 * 86_400_000);
  await spot.upsertMany([
    { assetId: btc.id, interval: '4h', openTime: old, closeTime: new Date(old.getTime() + H4), open: '1', high: '1', low: '1', close: '1', volume: '0', isClosed: true, sourceProvider: 'binance_klines', sourceUpdatedAt: old },
    { assetId: btc.id, interval: '4h', openTime: recent, closeTime: new Date(recent.getTime() + H4), open: '1', high: '1', low: '1', close: '1', volume: '0', isClosed: true, sourceProvider: 'binance_klines', sourceUpdatedAt: recent },
    { assetId: btc.id, interval: '1d', openTime: old, closeTime: new Date(old.getTime() + 86_400_000), open: '1', high: '1', low: '1', close: '1', volume: '0', isClosed: true, sourceProvider: 'binance_klines', sourceUpdatedAt: old },
  ]);
  await futures.upsertMany([{ futuresInstrumentId: instrument.id, interval: '4h', contractSymbol: sym, openTime: old,
    closeTime: new Date(old.getTime() + H4), open: '1', high: '1', low: '1', close: '1', volume: '0', isClosed: true, sourceUpdatedAt: old }]);
  const retention = new MarketCandleRetentionService(spot, { retentionDays: 35, batchSize: 1000, maxBatches: 1000 }, async () => undefined, futures);
  const pruned = await retention.run({ now: runAt });
  assert.ok(pruned.fourHour.deletedCount >= 1);
  assert.ok((pruned.futuresFourHour?.deletedCount ?? 0) >= 1);
  const btcRows = await prisma.marketCandle.findMany({ where: { assetId: btc.id, openTime: { in: [old, recent] } } });
  assert.deepEqual(btcRows.map((row) => row.interval + '@' + row.openTime.toISOString()).sort(), [
    '1d@' + old.toISOString(), '4h@' + recent.toISOString(),
  ]);
  const futOld = await prisma.futuresMarketCandle.count({ where: { futuresInstrumentId: instrument.id, openTime: old } });
  assert.equal(futOld, 0);
  console.log('long candle db smoke ok');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    const smokeTimes = [
      new Date('2026-10-13T00:00:00.000Z'), new Date('2026-10-13T04:00:00.000Z'),
      new Date('2026-03-27T00:00:00.000Z'), new Date('2026-07-05T00:00:00.000Z'),
    ];
    await prisma.futuresMarketCandle.deleteMany({ where: { contractSymbol: 'BTCUSDT', openTime: { in: smokeTimes } } });
    await prisma.marketCandle.deleteMany({ where: { OR: [
      { assetId: { in: created.assets } },
      { asset: { market: 'BINANCE', symbol: 'BTCUSDT' }, openTime: { in: smokeTimes } },
    ] } });
    await prisma.futuresInstrument.deleteMany({ where: { id: { in: created.instruments } } });
    await prisma.asset.deleteMany({ where: { id: { in: created.assets } } });
    await prisma.$disconnect();
  });
`;
