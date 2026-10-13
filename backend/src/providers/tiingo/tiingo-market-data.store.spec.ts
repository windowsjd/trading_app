jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
  };
});

import { TiingoMarketDataStore } from './tiingo-market-data.store';
import { parseTiingoTimestamp } from './tiingo.parser';

const ts = (text: string) => parseTiingoTimestamp(text)!;
const NO_LIQUIDITY = {
  spread: null,
  bidPrice: null,
  bidSize: null,
  askPrice: null,
  askSize: null,
  referencePrice: null,
};

describe('TiingoMarketDataStore', () => {
  it('keeps the newest reference and rejects duplicates and rollbacks', () => {
    const store = new TiingoMarketDataStore();
    const seen: string[] = [];
    store.onReference((observation) => seen.push(observation.price));
    const capturedAt = new Date('2026-10-13T14:31:00.000Z');
    expect(
      store.acceptReference({
        symbol: 'aapl',
        price: '247.1',
        timestamp: ts('2026-10-13T10:30:00.000000200-04:00'),
        capturedAt,
        origin: 'ws',
      }),
    ).toBe('accepted');
    // Same instant to the nanosecond → duplicate (even with another value).
    expect(
      store.acceptReference({
        symbol: 'AAPL',
        price: '999',
        timestamp: ts('2026-10-13T10:30:00.000000200-04:00'),
        capturedAt,
        origin: 'rest_snapshot',
      }),
    ).toBe('duplicate');
    // An older REST snapshot can never roll the stream value back.
    expect(
      store.acceptReference({
        symbol: 'AAPL',
        price: '246.9',
        timestamp: ts('2026-10-13T10:30:00.000000100-04:00'),
        capturedAt,
        origin: 'rest_snapshot',
      }),
    ).toBe('out_of_order');
    expect(store.latestReference('AAPL')?.price).toBe('247.1');
    expect(seen).toEqual(['247.1']);
    expect(store.symbolStats('AAPL').reference).toMatchObject({
      accepted: 1,
      duplicates: 1,
      outOfOrder: 1,
      lastSegment: 'regular',
    });
  });

  it('tracks the last regular-session value separately from extended hours', () => {
    const store = new TiingoMarketDataStore();
    store.acceptReference({
      symbol: 'AAPL',
      price: '250',
      timestamp: ts('2026-10-13T15:59:00-04:00'),
      capturedAt: new Date(),
      origin: 'ws',
    });
    store.acceptReference({
      symbol: 'AAPL',
      price: '251',
      timestamp: ts('2026-10-13T17:05:00-04:00'),
      capturedAt: new Date(),
      origin: 'ws',
    });
    expect(store.latestReference('AAPL')?.segment).toBe('after_hours');
    expect(store.latestRegularReference('AAPL')?.price).toBe('250');
    expect(store.symbolStats('AAPL').reference.bySegment).toMatchObject({
      regular: 1,
      after_hours: 1,
    });
  });

  it('classifies pre-market, overnight and non-trading-day observations', () => {
    const store = new TiingoMarketDataStore();
    const accept = (text: string) =>
      store.acceptLiquidity({
        symbol: 'AAPL',
        fields: NO_LIQUIDITY,
        timestamp: ts(text),
        capturedAt: new Date(),
        origin: 'ws',
      });
    accept('2026-10-13T04:30:00-04:00');
    accept('2026-10-13T21:00:00-04:00');
    accept('2026-10-17T12:00:00-04:00');
    expect(store.symbolStats('AAPL').liquidity.bySegment).toMatchObject({
      pre_market: 1,
      overnight: 1,
      non_trading_day: 1,
    });
  });

  it('expires remembered session closes and isolates failing listeners', () => {
    const store = new TiingoMarketDataStore();
    store.onReference(() => {
      throw new Error('consumer failure');
    });
    expect(
      store.acceptReference({
        symbol: 'AAPL',
        price: '1',
        timestamp: ts('2026-10-13T10:00:00-04:00'),
        capturedAt: new Date(),
        origin: 'ws',
      }),
    ).toBe('accepted');
    const close = store.latestReference('AAPL')!;
    store.rememberSessionClose('AAPL', '2026-10-12', close, 1_000, 10_000);
    expect(store.sessionClose('AAPL', '2026-10-12', 10_500)).toBe(close);
    expect(store.sessionClose('AAPL', '2026-10-12', 11_000)).toBeNull();
  });

  it('drops everything on clear (shutdown)', () => {
    const store = new TiingoMarketDataStore();
    store.acceptReference({
      symbol: 'AAPL',
      price: '1',
      timestamp: ts('2026-10-13T10:00:00-04:00'),
      capturedAt: new Date(),
      origin: 'ws',
    });
    store.onModuleDestroy();
    expect(store.latestReference('AAPL')).toBeNull();
    expect(store.symbolStats('AAPL').reference.accepted).toBe(0);
  });
});
