jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./binance/binance-order-book.service', () => ({
  BinanceOrderBookService: class {},
}));

import {
  MarketOrderBookSubscriptionService,
  matchesFuturesOrderBookTarget,
  matchesMarketOrderBookTarget,
} from './market-order-book-subscription.service';

it('keeps Binance subscription mapping at the provider boundary and validates book units', async () => {
  const service = new MarketOrderBookSubscriptionService({
    loadTargets: jest
      .fn()
      .mockResolvedValue(
        new Map([
          ['BTCUSDT', { assetId: 'btc', symbol: 'BTCUSDT', baseAsset: 'BTC' }],
        ]),
      ),
  } as never);
  const target = await service.loadTarget('btc');
  expect(target).toEqual({
    assetId: 'btc',
    priceUnit: 'USDT',
    quantityUnit: 'BTC',
    marketLabel: 'BTC / USDT',
  });
  expect(await service.loadTarget('unknown')).toBeNull();
  const book = {
    assetId: 'btc',
    priceUnit: 'USDT',
    quantityUnit: 'BTC',
    marketLabel: 'BTC / USDT',
    asks: [],
    bids: [],
    capturedAt: '2026-09-30T00:00:00.000Z',
    effectiveAt: null,
  };
  expect(matchesMarketOrderBookTarget(book, target!)).toBe(true);
  expect(
    matchesMarketOrderBookTarget({ ...book, quantityUnit: 'ETH' }, target!),
  ).toBe(false);
  expect(
    matchesMarketOrderBookTarget({ ...book, assetId: 'other' }, target!),
  ).toBe(false);
});

describe('USDⓈ-M order book subscription targets', () => {
  const now = new Date('2026-10-14T03:00:00Z');
  const instrument = (overrides: Record<string, unknown> = {}) => ({
    id: 'instrument-btc',
    underlyingAssetId: 'btc',
    isActive: true,
    productType: 'synthetic_perpetual',
    settlementCurrency: 'USD',
    markVerifiedAt: new Date(+now - 60_000),
    markContractJson: {
      symbol: 'BTCUSDT',
      pair: 'BTCUSDT',
      baseAsset: 'BTC',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      quoteAsset: 'USDT',
      marginAsset: 'USDT',
      underlyingType: 'COIN',
    },
    underlyingAsset: {
      symbol: 'BTCUSDT',
      isActive: true,
      assetType: 'crypto',
      market: 'BINANCE',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    ...overrides,
  });
  const service = (row: unknown) =>
    new MarketOrderBookSubscriptionService(
      {} as never,
      {
        futuresInstrument: { findUnique: jest.fn().mockResolvedValue(row) },
      } as never,
    );

  it('keys a verified contract by instrument, not by its underlying asset', async () => {
    const target = await service(instrument()).loadFuturesTarget(
      'instrument-btc',
      now,
    );
    expect(target).toEqual({
      instrumentId: 'instrument-btc',
      symbol: 'BTCUSDT',
      priceUnit: 'USDT',
      quantityUnit: 'BTC',
      marketLabel: 'BTC / USDT 무기한',
    });
    const book = {
      ...target!,
      asks: [],
      bids: [],
      capturedAt: now.toISOString(),
      effectiveAt: null,
    };
    expect(matchesFuturesOrderBookTarget(book, target!)).toBe(true);
    expect(
      matchesFuturesOrderBookTarget({ ...book, instrumentId: 'btc' }, target!),
    ).toBe(false);
    expect(
      matchesFuturesOrderBookTarget({ ...book, symbol: 'ETHUSDT' }, target!),
    ).toBe(false);
  });

  it.each([
    ['a missing instrument', null],
    ['an inactive instrument', instrument({ isActive: false })],
    ['an unverified contract', instrument({ markVerifiedAt: null })],
    [
      'an expired verification',
      instrument({ markVerifiedAt: new Date(+now - 25 * 3_600_000) }),
    ],
  ])('refuses %s', async (_name, row) => {
    expect(
      (await service(row).loadFuturesTarget('instrument-btc', now)) === null,
    ).toBe(true);
  });

  it('refuses without a database or an oversized id', async () => {
    const withoutDb = new MarketOrderBookSubscriptionService({} as never);
    expect(
      (await withoutDb.loadFuturesTarget('instrument-btc', now)) === null,
    ).toBe(true);
    expect(
      (await service(instrument()).loadFuturesTarget('x'.repeat(81), now)) ===
        null,
    ).toBe(true);
  });
});
