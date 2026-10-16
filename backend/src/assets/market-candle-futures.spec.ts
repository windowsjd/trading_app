jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{
    Decimal: unknown;
    sqltag: unknown;
    join: unknown;
  }>('@prisma/client/runtime/client');
  return {
    PrismaClient: class PrismaClient {},
    Prisma: {
      Decimal: runtime.Decimal,
      sql: runtime.sqltag,
      join: runtime.join,
    },
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  FuturesMarketCandleValidationError,
  FuturesMarketCandlesRepository,
} from './market-candle-futures.repository';
import { FuturesCandlesService } from './market-candle-futures.service';

const H4 = 4 * 3600_000;

function stored(openMs: number, isClosed: boolean, price = 100) {
  return {
    id: `row-${openMs}`,
    futuresInstrumentId: 'fut-btc',
    interval: '4h',
    contractSymbol: 'BTCUSDT',
    openTime: new Date(openMs),
    closeTime: new Date(openMs + H4),
    open: new Prisma.Decimal(price),
    high: new Prisma.Decimal(price + 2),
    low: new Prisma.Decimal(price - 2),
    close: new Prisma.Decimal(price + 1),
    volume: new Prisma.Decimal(3),
    amount: null,
    isClosed,
    sourceProvider: 'binance_usdm_klines',
    sourceUpdatedAt: new Date(openMs + 60_000),
    createdAt: new Date(openMs),
    updatedAt: new Date(openMs),
  };
}

const instrumentRow = (symbol = 'BTCUSDT', overrides = {}) => ({
  id: 'fut-btc',
  isActive: true,
  productType: 'synthetic_perpetual',
  settlementCurrency: 'USD',
  markContractJson: { priceTickSize: '0.10' },
  underlyingAsset: {
    symbol,
    name: 'Bitcoin',
    market: 'BINANCE',
    assetType: 'crypto',
  },
  ...overrides,
});

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as { error: { code: string } };
      return `${error.getStatus()}:${body.error.code}`;
    }
    return 'unexpected';
  }
  return 'resolved';
}

describe('FuturesCandlesService', () => {
  const now = new Date('2026-10-13T10:30:00.000Z');
  const currentStart = Math.floor(now.getTime() / H4) * H4;

  const create = (
    rows: ReturnType<typeof stored>[],
    instrument: unknown = instrumentRow(),
  ) => {
    const prisma = {
      futuresInstrument: {
        findUnique: jest.fn().mockResolvedValue(instrument),
      },
    };
    const repository = { findRange: jest.fn().mockResolvedValue(rows) };
    return {
      prisma,
      repository,
      service: new FuturesCandlesService(prisma as never, repository as never),
    };
  };

  it('returns contract klines oldest→newest with only the current bucket provisional', async () => {
    const rows = [
      stored(currentStart - 3 * H4, true),
      stored(currentStart - 2 * H4, true),
      // An open row from an ended window (collection stopped) is withheld.
      stored(currentStart - H4, false),
      stored(currentStart, false, 200),
    ];
    const { service, repository } = create(rows);
    const response = await service.getInstrumentCandles(
      'user-1',
      'fut-btc',
      {},
      now,
    );
    const data = response.data;
    expect(data.priceBasis).toBe('contract_last_trade');
    expect(data.source.endpoint).toBe('/fapi/v1/klines');
    expect(data.instrument.symbol).toBe('BTCUSDT');
    expect(data.instrument.displayPriceDecimals).toBe(1);
    expect(data.candles.map((c) => c.provisional)).toEqual([
      false,
      false,
      true,
    ]);
    expect(data.candles.map((c) => Date.parse(c.time))).toEqual([
      currentStart - 3 * H4,
      currentStart - 2 * H4,
      currentStart,
    ]);
    expect(data.source.provisionalUpdatedAt).toBe(
      new Date(currentStart + 60_000).toISOString(),
    );
    const [call] = repository.findRange.mock.calls[0] as unknown as [
      { futuresInstrumentId: string; interval: string; from: Date; to: Date },
    ];
    expect(call.futuresInstrumentId).toBe('fut-btc');
    expect(call.interval).toBe('4h');
    expect(call.to.getTime()).toBe(currentStart + H4);
    expect(now.getTime() - call.from.getTime()).toBe(96 * 86_400_000);
    // Market data only: no account, position or permission fields.
    expect(JSON.stringify(response).includes('tradingAccountId')).toBe(false);
  });

  it('serves a futures-only contract (no Spot product) from its own rows', async () => {
    const { service } = create(
      [stored(currentStart - H4, true)],
      instrumentRow('HYPEUSDT'),
    );
    const response = await service.getInstrumentCandles(
      'user-1',
      'fut-btc',
      {},
      now,
    );
    expect(response.data.instrument.symbol).toBe('HYPEUSDT');
    expect(response.data.candles.length).toBe(1);
  });

  it('applies the requested limit to the newest candles', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      stored(currentStart - (10 - i) * H4, true),
    );
    const { service } = create(rows);
    const response = await service.getInstrumentCandles(
      'user-1',
      'fut-btc',
      { limit: '3' },
      now,
    );
    expect(response.data.candles.length).toBe(3);
    expect(Date.parse(response.data.candles[2].time)).toBe(currentStart - H4);
  });

  it('rejects unknown, non-catalog and non-perpetual instruments, bad queries and anonymous reads', async () => {
    expect(
      await errorCode(
        create([], null).service.getInstrumentCandles(
          'user-1',
          'fut-x',
          {},
          now,
        ),
      ),
    ).toBe('404:FUTURES_INSTRUMENT_NOT_FOUND');
    expect(
      await errorCode(
        create([], instrumentRow('BICOUSDT')).service.getInstrumentCandles(
          'user-1',
          'fut-btc',
          {},
          now,
        ),
      ),
    ).toBe('404:FUTURES_INSTRUMENT_NOT_FOUND');
    for (const query of [
      { interval: '1h' },
      { range: '30d' },
      { limit: '0' },
      { limit: '1001' },
      { limit: '5x' },
    ]) {
      expect(
        await errorCode(
          create([]).service.getInstrumentCandles(
            'user-1',
            'fut-btc',
            query,
            now,
          ),
        ),
      ).toBe('400:FUTURES_CANDLES_INVALID_QUERY');
    }
    expect(
      await errorCode(
        create([]).service.getInstrumentCandles(undefined, 'fut-btc', {}, now),
      ),
    ).toBe('401:UNAUTHORIZED');
  });

  it('shares one database read between concurrent viewers of the same contract', async () => {
    const { service, repository } = create([stored(currentStart - H4, true)]);
    await Promise.all([
      service.getInstrumentCandles('user-1', 'fut-btc', {}, now),
      service.getInstrumentCandles('user-2', 'fut-btc', {}, now),
      service.getInstrumentCandles('user-3', 'fut-btc', {}, now),
    ]);
    await service.getInstrumentCandles('user-4', 'fut-btc', {}, now);
    expect(repository.findRange).toHaveBeenCalledTimes(1);
  });
});

describe('FuturesMarketCandlesRepository', () => {
  const create = () => {
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      futuresMarketCandle: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return {
      prisma,
      repository: new FuturesMarketCandlesRepository(prisma as never),
    };
  };
  const input = (overrides = {}) => ({
    futuresInstrumentId: 'fut-btc',
    interval: '4h' as const,
    contractSymbol: 'BTCUSDT',
    openTime: new Date('2026-10-13T08:00:00.000Z'),
    closeTime: new Date('2026-10-13T12:00:00.000Z'),
    open: '100',
    high: '102',
    low: '99',
    close: '101',
    volume: '3',
    amount: '300',
    isClosed: false,
    sourceUpdatedAt: new Date('2026-10-13T10:30:00.000Z'),
    ...overrides,
  });

  it('upserts on the instrument key and never downgrades a closed bucket', async () => {
    const { prisma, repository } = create();
    await repository.upsertMany([
      input(),
      input({ close: '101.5', high: '102' }),
    ]);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [query] = prisma.$executeRaw.mock.calls[0] as unknown as [
      { strings: string[]; values: unknown[] },
    ];
    const text = query.strings.join('?');
    expect(text).toContain('INSERT INTO "futures_market_candles"');
    expect(text).toContain(
      'ON CONFLICT ("futures_instrument_id", "interval", "open_time")',
    );
    expect(text).toContain(
      'NOT ("futures_market_candles"."is_closed" AND NOT EXCLUDED."is_closed")',
    );
    expect(text.includes('"market_candles"')).toBe(false);
    // Duplicate keys in one batch: the last input wins, one row is written.
    expect(query.values.filter((value) => value === 'fut-btc').length).toBe(1);
    expect(query.values.includes('binance_usdm_klines')).toBe(true);
  });

  it('rejects invalid identity and OHLC before any SQL', async () => {
    const { prisma, repository } = create();
    for (const bad of [
      { contractSymbol: 'btcusdt' },
      { interval: '5m' },
      { high: '98' },
      { open: '0' },
      { volume: '-1' },
      { closeTime: new Date('2026-10-13T08:00:00.000Z') },
      { open: '1.123456789' },
    ]) {
      await expect(
        repository.upsertMany([input(bad as never)]),
      ).rejects.toBeInstanceOf(FuturesMarketCandleValidationError);
    }
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('prunes only closed rows in bounded batches', async () => {
    const { prisma, repository } = create();
    await repository.deleteClosedBeforeBatch({
      cutoff: new Date('2026-04-16T00:00:00Z'),
      interval: '4h',
      limit: 500,
    });
    const [deleteQuery] = prisma.$executeRaw.mock.calls[0] as unknown as [
      { strings: string[] },
    ];
    const text = deleteQuery.strings.join('?');
    expect(text).toContain('"is_closed" = TRUE');
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    await expect(
      repository.deleteClosedBeforeBatch({
        cutoff: new Date(),
        interval: '4h',
        limit: 10_001,
      }),
    ).rejects.toBeInstanceOf(FuturesMarketCandleValidationError);
  });
});
