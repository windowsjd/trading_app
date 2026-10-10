jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal: runtime.Decimal },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  };
});

import { AssetType, CurrencyCode, Prisma } from '../generated/prisma/client';
import type { ParsedAssetCandlesQuery } from './asset-candles.service';
import { CandleResponseBuilder } from './candle-response.builder';

describe('CandleResponseBuilder.buildPersisted source diagnostics', () => {
  const builder = new CandleResponseBuilder();
  const clock = new Date('2026-07-13T00:00:00.000Z');

  const asset = (
    assetType: AssetType,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: 'asset-1',
    symbol: assetType === AssetType.crypto ? 'BTCUSDT' : '005930',
    name: 'Test',
    market: assetType === AssetType.crypto ? 'BINANCE' : 'KOSPI',
    assetType,
    currencyCode: CurrencyCode.KRW,
    priceCurrency: CurrencyCode.KRW,
    settlementCurrency: CurrencyCode.KRW,
    isActive: true,
    ...overrides,
  });

  const query = (
    range: ParsedAssetCandlesQuery['range'],
    interval: ParsedAssetCandlesQuery['interval'],
    limit: number,
  ): ParsedAssetCandlesQuery => ({
    range,
    rangeProvided: true,
    rangeStartAt: new Date(clock.getTime() - 14 * 86_400_000),
    rangeEndAt: clock,
    interval,
    intervalMinutes: 30,
    limit,
    requestedDate: '2026-07-13',
    toHHmmss: '000000',
    toInstant: clock,
    dateProvided: true,
    toProvided: true,
    includePrevious: true,
    explicitDate: false,
    explicitTo: false,
    clock,
  });

  const row = (minute: number) => ({
    openTime: new Date(clock.getTime() - minute * 60_000),
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(101),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(100.5),
    volume: new Prisma.Decimal(10),
    amount: null,
  });

  // The dev diagnostic on the chart reads `req=` from here. A database answer
  // must echo the limit the frontend asked for; `req=120` would mean the
  // request fell back to a single truncated KIS minute page.
  it.each([
    ['14d', '30m', 672] as const,
    ['14d', '1h', 336] as const,
    ['30d', '4h', 200] as const,
  ])(
    'reports the requested %s/%s limit (%i) for a stock database answer',
    (range, interval, limit) => {
      const response = builder.buildPersisted(
        asset(AssetType.domestic_stock),
        query(range, interval, limit),
        [row(30), row(0)],
      );
      expect(response.data.source).toMatchObject({
        provider: 'koscom',
        requestedCount: limit,
        returnedCount: 2,
      });
      expect(response.data.source.requestedCount).not.toBe(120);
      expect(response.data.range).toBe(range);
      expect(response.data.interval).toBe(interval);
    },
  );

  it('preserves a verified Han symbol in persisted crypto candle responses', () => {
    const response = builder.buildPersisted(
      asset(AssetType.crypto, { symbol: '币安人生USDT' }),
      query('14d', '30m', 672),
      [],
    );
    expect(response.data.source).toMatchObject({ symbol: '币安人生USDT' });
  });

  it('keeps historical KIS provenance and reports a mixed chart across the provider boundary', () => {
    const candles = [
      { ...row(30), sourceProvider: 'kis_domestic_minute' },
      { ...row(0), sourceProvider: 'koscom_intraday' },
    ];
    const response = builder.buildPersisted(
      asset(AssetType.domestic_stock),
      query('14d', '30m', 672),
      candles,
    );
    expect(response.data.source).toMatchObject({
      provider: 'mixed',
      sourceProviders: ['kis_domestic_minute', 'koscom_intraday'],
      returnedCount: 2,
    });
    expect(response.data.candles.map((c) => c.close)).toEqual([
      '100.50000000',
      '100.50000000',
    ]);
    const old = builder.buildPersisted(
      asset(AssetType.domestic_stock),
      query('14d', '30m', 672),
      [candles[0]],
    );
    expect(old.data.source.provider).toBe('kis');
  });

  it('clamps the crypto requestedCount at the Binance single-call cap', () => {
    const response = builder.buildPersisted(
      asset(AssetType.crypto, {
        currencyCode: CurrencyCode.USD,
        priceCurrency: CurrencyCode.USD,
      }),
      query('14d', '30m', 672),
      [row(0)],
    );
    expect(response.data.source).toMatchObject({
      provider: 'binance',
      symbol: 'BTCUSDT',
      requestedCount: 672,
      returnedCount: 1,
    });
  });
});
