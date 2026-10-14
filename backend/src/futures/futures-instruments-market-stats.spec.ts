jest.mock('./futures-performance.service', () => ({
  FuturesPerformanceService: class {},
}));
jest.mock('./futures-instrument-coverage', () => ({
  verifiedFuturesInstrument: () => true,
}));
jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
    PrismaClientKnownRequestError: class extends Error {},
    join: () => ({}),
    sql: () => ({}),
  },
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../trading-accounts/trading-account-access.service', () => ({
  TradingAccountAccessService: class {},
}));
jest.mock('../portfolio/general-account-performance.service', () => ({
  GeneralAccountPerformanceService: class {},
}));
jest.mock('./futures-reference-prices', () => ({
  readFuturesReferencePrices: jest.fn(),
}));

import { FuturesService } from './futures.service';
import { readFuturesReferencePrices } from './futures-reference-prices';
import type { FuturesMarketStats } from './futures-market-data';

const now = new Date('2026-10-14T03:00:00.000Z');
const row = (id: string, symbol: string) => ({
  id,
  underlyingAssetId: `asset-${id}`,
  productType: 'synthetic_perpetual',
  settlementCurrency: 'USD',
  isActive: true,
  markVerifiedAt: new Date(+now - 60_000),
  markContractJson: { priceTickSize: '0.10' },
  underlyingAsset: { symbol, name: symbol, market: 'BINANCE' },
});
const stats = (symbol: string, receivedAt: Date): FuturesMarketStats => ({
  symbol,
  priceChangePercent: '-2.345',
  quoteVolume: '987654321.12',
  windowOpenTime: new Date(+receivedAt - 86_400_000).toISOString(),
  windowCloseTime: receivedAt.toISOString(),
  eventTime: receivedAt.toISOString(),
  receivedAt: receivedAt.toISOString(),
});

function service(read: () => Promise<Map<string, FuturesMarketStats>>) {
  jest.mocked(readFuturesReferencePrices).mockResolvedValue(
    new Map([
      ['i-btc', { last: null, mark: null }],
      ['i-eth', { last: null, mark: null }],
      ['i-sol', { last: null, mark: null }],
    ]) as never,
  );
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ now }]),
    futuresInstrument: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          row('i-btc', 'BTCUSDT'),
          row('i-eth', 'ETHUSDT'),
          row('i-sol', 'SOLUSDT'),
        ]),
    },
  };
  return new FuturesService(
    prisma as never,
    {
      getOwnedAccountOrThrow: jest
        .fn()
        .mockResolvedValue({
          id: 'account',
          mode: 'general',
          status: 'active',
        }),
    } as never,
    {} as never,
    undefined,
    { read } as never,
  );
}

describe('Futures catalog 24h statistics', () => {
  it('attaches each contract its own current ticker and never invents one', async () => {
    const response = await service(() =>
      Promise.resolve(
        new Map([
          ['BTCUSDT', stats('BTCUSDT', new Date(+now - 2_000))],
          // Older than the freshness window: not current.
          ['ETHUSDT', stats('ETHUSDT', new Date(+now - 61_000))],
        ]),
      ),
    ).instruments('user', 'account');
    const byId = new Map(
      response.data.instruments.map((instrument) => [
        instrument.id,
        instrument.marketStats,
      ]),
    );
    expect(byId.get('i-btc')).toMatchObject({
      state: 'available',
      priceChangePercent: '-2.345',
      quoteVolume: '987654321.12',
    });
    for (const id of ['i-eth', 'i-sol'])
      expect(byId.get(id)).toEqual({
        state: 'unavailable',
        priceChangePercent: null,
        quoteVolume: null,
        windowOpenTime: null,
        windowCloseTime: null,
        receivedAt: null,
      });
  });

  it('serves the catalog without statistics when no store is wired', async () => {
    jest
      .mocked(readFuturesReferencePrices)
      .mockResolvedValue(
        new Map([['i-btc', { last: null, mark: null }]]) as never,
      );
    const plain = new FuturesService(
      {
        $queryRaw: jest.fn().mockResolvedValue([{ now }]),
        futuresInstrument: {
          findMany: jest.fn().mockResolvedValue([row('i-btc', 'BTCUSDT')]),
        },
      } as never,
      {
        getOwnedAccountOrThrow: jest.fn().mockResolvedValue({
          id: 'account',
          mode: 'general',
          status: 'active',
        }),
      } as never,
      {} as never,
    );
    const response = await plain.instruments('user', 'account');
    expect(response.data.instruments[0].marketStats.state).toBe('unavailable');
  });
});
