jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { parseBinanceMark, validMark, readFuturesMark } from './futures-mark';
import { futuresDecimal as d } from './futures-math';
import type { InstrumentWithAsset } from './futures.presenter';
import type { Prisma, FuturesMarkSnapshot } from '../generated/prisma/client';
const now = new Date('2026-10-07T00:00:10Z');
const inst = {
  id: 'i',
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
const row = {
  id: 'm',
  instrumentId: 'i',
  symbol: 'BTCUSDT',
  providerProduct: 'binance_usdm_perpetual',
  currencyCode: 'USD',
  source: 'binance_usdm_mark_ws',
  price: d('100'),
  effectiveAt: new Date(now.getTime() - 1000),
  capturedAt: now,
} as FuturesMarkSnapshot;
const ws = {
  e: 'markPriceUpdate',
  s: 'BTCUSDT',
  p: '100.12345678',
  E: now.getTime() - 1000,
  st: 1,
};
describe('Binance public Mark evidence is typed and fresh', () => {
  it('accepts WS E and REST time with explicit capture time', () => {
    expect(
      parseBinanceMark(ws, row.source, 'BTCUSDT', now)?.price.toString(),
    ).toBe('100.12345678');
    expect(
      parseBinanceMark(
        { symbol: 'BTCUSDT', markPrice: '100', time: ws.E },
        'binance_usdm_mark_rest',
        'BTCUSDT',
        now,
      )?.effectiveAt.getTime(),
    ).toBe(ws.E);
  });
  it.each([
    { e: '24hrTicker' },
    { s: 'ETHUSDT' },
    { p: 'NaN' },
    { p: '0' },
    { p: '1e5' },
    { st: 2 },
    { E: now.getTime() + 1 },
    { E: now.getTime() - 5001 },
  ])('rejects invalid provider identity/time %j', (patch) => {
    expect(
      parseBinanceMark({ ...ws, ...patch }, row.source, 'BTCUSDT', now),
    ).toBeNull();
  });
  it.each([
    { instrumentId: 'other' },
    { symbol: 'ETHUSDT' },
    { currencyCode: 'KRW' },
    { providerProduct: 'spot' },
    { source: 'binance_spot_ws_ticker' },
    { capturedAt: new Date(now.getTime() + 1) },
    { effectiveAt: new Date(now.getTime() + 1) },
    { effectiveAt: new Date(now.getTime() - 5001) },
  ])('rejects wrong risk evidence %j', (patch) => {
    expect(
      validMark({ ...row, ...patch } as FuturesMarkSnapshot, inst, now),
    ).toBe(false);
  });
  it('accepts exact 5 seconds, rejects stale or future received timestamps', () => {
    expect(
      validMark(
        { ...row, effectiveAt: new Date(now.getTime() - 5000) },
        inst,
        now,
      ),
    ).toBe(true);
    expect(
      validMark(
        { ...row, capturedAt: new Date(now.getTime() - 5001) },
        inst,
        now,
      ),
    ).toBe(false);
  });
  it('chooses fresh WS before REST and recovers with REST when WS is stale', async () => {
    let rows = [row, { ...row, id: 'rest', source: 'binance_usdm_mark_rest' }];
    const findFirst = jest.fn(({ where }) =>
      Promise.resolve(rows.find((r) => r.source === where.source) ?? null),
    );
    const tx = {
      futuresMarkSnapshot: { findFirst },
    } as unknown as Prisma.TransactionClient;
    expect((await readFuturesMark(tx, inst, now))?.id).toBe('m');
    rows = [{ ...row, effectiveAt: new Date(now.getTime() - 6000) }, rows[1]];
    expect((await readFuturesMark(tx, inst, now))?.id).toBe('rest');
    rows = [];
    expect(await readFuturesMark(tx, inst, now, false)).toBeNull();
    await expect(readFuturesMark(tx, inst, now)).rejects.toThrow();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { effectiveAt: 'desc' },
          { capturedAt: 'desc' },
          { id: 'desc' },
        ],
      }),
    );
  });
});
