jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual('@prisma/client/runtime/client');
  return {
    Prisma: {
      Decimal: runtime.Decimal,
      sql: runtime.sqltag,
      join: runtime.join,
    },
  };
});
import {
  Prisma,
  type FuturesLastPriceSnapshot,
  type FuturesMarkSnapshot,
} from '../generated/prisma/client';
import type { InstrumentWithAsset } from './futures.presenter';
import { readFuturesReferencePrices } from './futures-reference-prices';

describe('batched read-only Futures catalog evidence', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const instrument = {
    id: 'btc',
    productType: 'synthetic_perpetual',
    settlementCurrency: 'USD',
    underlyingAsset: {
      symbol: 'BTCUSDT',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  } as InstrumentWithAsset;
  const last = {
    id: 'last',
    instrumentId: 'btc',
    symbol: 'BTCUSDT',
    source: 'binance_usdm_agg_trade_ws',
    currencyCode: 'USD',
    providerProduct: 'binance_usdm_perpetual',
    price: new Prisma.Decimal('100'),
    effectiveAt: new Date(+now - 1000),
    capturedAt: now,
  } as FuturesLastPriceSnapshot;
  const mark = {
    ...last,
    id: 'mark',
    source: 'binance_usdm_mark_ws',
  } as unknown as FuturesMarkSnapshot;
  const read = async (lastRows = [last], markRows = [mark]) => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(lastRows)
      .mockResolvedValueOnce(markRows);
    const result = await readFuturesReferencePrices(
      { $queryRaw: query } as never,
      [instrument],
      now,
    );
    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls.map(([s]) => s.sql);
    expect(sql.every((s) => s.includes('CROSS JOIN LATERAL'))).toBe(true);
    expect(
      sql.every((s) => !s.includes('INSERT') && !s.includes('UPDATE')),
    ).toBe(true);
    return result.get('btc')!;
  };
  it('skips queries for an empty verified catalog', async () => {
    const query = jest.fn();
    expect(
      (await readFuturesReferencePrices({ $queryRaw: query } as never, [], now))
        .size,
    ).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
  it('keeps Last and Mark identities separate in a fixed two-query budget', async () => {
    const result = await read();
    expect(result.last?.id).toBe('last');
    expect(result.mark?.id).toBe('mark');
  });
  it.each([
    { capturedAt: new Date(+now - 10001), effectiveAt: new Date(+now - 10001) },
    { effectiveAt: new Date(+now - 60001) },
    { effectiveAt: new Date(+now + 1) },
    { symbol: 'ETHUSDT' },
    { price: new Prisma.Decimal(0) },
    { source: 'binance_usdm_mark_ws' },
  ])(
    'fails closed on rejected Last evidence without substituting Mark: %j',
    async (patch) => {
      expect(
        (await read([{ ...last, ...patch } as FuturesLastPriceSnapshot]))
          .last === null,
      ).toBe(true);
    },
  );
  it('preserves per-source Mark priority and falls back only to valid Mark REST', async () => {
    const rest = {
      ...mark,
      id: 'rest',
      source: 'binance_usdm_mark_rest',
    } as FuturesMarkSnapshot;
    expect((await read([last], [rest, mark])).mark?.id).toBe('mark');
    expect(
      (
        await read(
          [last],
          [rest, { ...mark, effectiveAt: new Date(+now - 5001) }],
        )
      ).mark?.id,
    ).toBe('rest');
    expect(
      (await read([], [{ ...mark, symbol: 'ETHUSDT' }])).mark === null,
    ).toBe(true);
  });
});
