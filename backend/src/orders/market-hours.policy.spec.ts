jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
}));

import { AssetType } from '../generated/prisma/client';
import {
  assertAssetTradable,
  getAssetTradingStatus,
} from './market-hours.policy';

describe('market hours policy', () => {
  const krxAsset = { assetType: AssetType.domestic_stock, market: 'KRX' };
  const nasAsset = { assetType: AssetType.us_stock, market: 'NAS' };
  const cryptoAsset = { assetType: AssetType.crypto, market: 'BINANCE' };

  it.each([
    ['2026-06-18T23:59:59.000Z', false],
    ['2026-06-19T00:00:00.000Z', true],
    ['2026-06-19T06:29:59.000Z', true],
    ['2026-06-19T06:30:00.000Z', false],
    ['2026-06-20T01:00:00.000Z', false],
    ['2026-06-21T01:00:00.000Z', false],
    ['2026-01-01T01:00:00.000Z', false],
  ])('checks KRX regular session at %s', (iso, tradable) => {
    expect(getAssetTradingStatus(krxAsset, new Date(iso)).tradable).toBe(
      tradable,
    );
  });

  it.each([
    ['2026-01-15T14:29:59.000Z', false],
    ['2026-01-15T14:30:00.000Z', true],
    ['2026-01-15T20:59:59.000Z', true],
    ['2026-01-15T21:00:00.000Z', false],
    ['2026-06-18T13:29:59.000Z', false],
    ['2026-06-18T13:30:00.000Z', true],
    ['2026-06-18T19:59:59.000Z', true],
    ['2026-06-18T20:00:00.000Z', false],
    ['2026-06-20T14:00:00.000Z', false],
    ['2026-01-01T15:00:00.000Z', false],
  ])('checks US regular session with DST at %s', (iso, tradable) => {
    expect(getAssetTradingStatus(nasAsset, new Date(iso)).tradable).toBe(
      tradable,
    );
  });

  it('does not close crypto for market-hours reasons', () => {
    expect(
      getAssetTradingStatus(cryptoAsset, new Date('2026-06-21T01:00:00.000Z')),
    ).toEqual({ tradable: true });
  });

  it('throws MARKET_CLOSED for closed markets', () => {
    expect(() =>
      assertAssetTradable(krxAsset, new Date('2026-06-19T06:30:00.000Z')),
    ).toThrow(expect.objectContaining({ code: 'MARKET_CLOSED' }));
  });
});
