// The real generated enums (AssetType, CurrencyCode, …) without the client.
jest.mock('../generated/prisma/client', () => ({
  ...jest.requireActual<object>('../generated/prisma/enums'),
  Prisma: {
    Decimal: jest.requireActual<typeof import('@prisma/client/runtime/client')>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
import { HttpException } from '@nestjs/common';
import type { Asset } from '../generated/prisma/client';
import { conditionalRegistrationReference } from './conditional-price';

/**
 * Registration reference of a new conditional BUY / SELL condition
 * (2026-10-18), on the real static calendar (passthrough override store):
 * a confirmed-closed stock market registers without reading a price, an
 * open session or crypto keeps the fresh-price rule, and an undecidable
 * calendar fails closed with its own code. PostgreSQL coverage lives in
 * scripts/conditional-{buy,sell}-orders-integration.ts (offSessionRegistration).
 */
function tx() {
  const findMany = jest.fn(() => Promise.resolve([]));
  return {
    client: {
      assetPriceSnapshot: { findMany },
      futuresInstrument: { findUnique: jest.fn() },
      futuresLastPriceSnapshot: { findMany: jest.fn() },
    },
    findMany,
  };
}
const asset = (patch: Partial<Asset>) =>
  ({
    id: 'asset-1',
    symbol: '005930',
    market: 'KRX',
    assetType: 'domestic_stock',
    currencyCode: 'KRW',
    priceCurrency: 'KRW',
    settlementCurrency: 'KRW',
    isActive: true,
    ...patch,
  }) as Asset;
const run = (subject: Asset, at: string) => {
  const h = tx();
  return {
    h,
    result: conditionalRegistrationReference(
      h.client as never,
      subject,
      new Date(at),
    ),
  };
};
function errorCode(error: unknown) {
  if (!(error instanceof HttpException)) return 'NOT_HTTP';
  return (
    (error.getResponse() as { error?: { code?: string } }).error?.code ??
    'NO_CODE'
  );
}

describe('conditional registration reference', () => {
  // Saturday 2026-10-17 10:00 KST / Friday 21:00 New York: both closed.
  const weekend = '2026-10-17T01:00:00.000Z';
  // Monday 2026-10-19 10:00 KST: the KRX regular session.
  const krxSession = '2026-10-19T01:00:00.000Z';

  it('a confirmed-closed KRX or US market registers off-session without reading a price', async () => {
    for (const subject of [
      asset({}),
      asset({
        market: 'NAS',
        assetType: 'us_stock',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      }),
    ]) {
      const { h, result } = run(subject, weekend);
      await expect(result).resolves.toBe('off_session');
      expect(h.findMany).not.toHaveBeenCalled();
    }
  });

  it('the KRX regular session keeps the fresh-price rule (no price: null, never off-session)', async () => {
    const { result } = run(asset({}), krxSession);
    await expect(result).resolves.toBeNull();
  });

  it('crypto never closes: it always needs a fresh price, even on a weekend', async () => {
    const { result } = run(
      asset({
        symbol: 'BTCUSDT',
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      }),
      weekend,
    );
    await expect(result).resolves.toBeNull();
  });

  it('an undecidable calendar is refused with its own code, never taken for a closure', async () => {
    // KRX static coverage ends with 2027.
    let observed = 'RESOLVED';
    try {
      await run(asset({}), '2030-01-07T01:00:00.000Z').result;
    } catch (error) {
      observed = errorCode(error);
    }
    expect(observed).toBe('MARKET_CALENDAR_UNAVAILABLE');
  });

  it('an inactive asset is no off-session registration either', async () => {
    const { h, result } = run(asset({ isActive: false }), weekend);
    await expect(result).resolves.toBeNull();
    expect(h.findMany).not.toHaveBeenCalled();
  });
});
