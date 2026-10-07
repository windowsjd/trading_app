jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { Prisma, type Asset } from '../generated/prisma/client';
import { readFuturesPrice } from './futures-price';
const now = new Date('2026-10-07T12:00:00Z');
const asset = {
  id: 'btc',
  assetType: 'crypto',
  market: 'BINANCE',
  currencyCode: 'USD',
} as Asset;
const row = {
  id: 's',
  assetId: 'btc',
  currencyCode: 'USD',
  price: new Prisma.Decimal('100'),
  sourceType: 'provider_api',
  sourceName: 'binance_spot_ws_ticker',
  effectiveAt: new Date(now.getTime() - 1000),
  capturedAt: new Date(now.getTime() - 1000),
  createdAt: now,
};
function client(rows: unknown[]) {
  return {
    assetPriceSnapshot: { findMany: jest.fn().mockResolvedValue(rows) },
  } as unknown as Pick<Prisma.TransactionClient, 'assetPriceSnapshot'>;
}
describe('Futures canonical synthetic price evidence', () => {
  it('uses the existing WS before REST source priority', async () => {
    const rest = {
      ...row,
      id: 'rest',
      sourceName: 'binance_public_rest_24hr_ticker',
      price: new Prisma.Decimal('101'),
    };
    expect((await readFuturesPrice(client([rest, row]), asset, now))?.id).toBe(
      's',
    );
  });
  it.each([
    { assetId: 'eth' },
    { currencyCode: 'KRW' },
    { sourceName: 'binance_futures' },
    { sourceType: 'admin_manual' },
    { price: new Prisma.Decimal('0') },
    { capturedAt: new Date(now.getTime() - 12000) },
    { capturedAt: new Date(now.getTime() + 1) },
    { effectiveAt: new Date(now.getTime() + 1) },
  ])(
    'rejects invalid evidence %j and returns no read PnL basis',
    async (patch) => {
      await expect(
        readFuturesPrice(client([{ ...row, ...patch }]), asset, now),
      ).rejects.toThrow();
      expect(
        await readFuturesPrice(
          client([{ ...row, ...patch }]),
          asset,
          now,
          false,
        ),
      ).toBeNull();
    },
  );
  it('rejects missing and execution-time stale evidence', async () => {
    await expect(readFuturesPrice(client([]), asset, now)).rejects.toThrow();
    await expect(
      readFuturesPrice(client([row]), asset, new Date(now.getTime() + 11000)),
    ).rejects.toThrow();
  });
});
