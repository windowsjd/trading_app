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
  MarketHoursError,
} from './market-hours.policy';
import {
  applyMarketSessionOverrideSnapshot,
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from './market-calendar/market-session-override.store';

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
    ['2026-02-17T01:00:00.000Z', false],
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
    ['2026-07-03T14:00:00.000Z', false],
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

  describe('with operator DB overrides', () => {
    afterEach(() => {
      resetMarketSessionOverrideStoreForTest();
    });

    it('rejects orders with MARKET_CLOSED on an override-closed regular day', () => {
      const midday = new Date('2026-07-13T03:00:00.000Z');
      expect(getAssetTradingStatus(krxAsset, midday).tradable).toBe(true);

      applyMarketSessionOverrideSnapshot(
        [
          {
            market: 'KRX',
            localDate: '2026-07-13',
            overrideType: 'closed',
            openTime: null,
            closeTime: null,
            reason: 'emergency closure',
          },
        ],
        new Date(),
      );

      expect(getAssetTradingStatus(krxAsset, midday)).toMatchObject({
        tradable: false,
        reason: 'MARKET_CLOSED',
        message: 'KRX market is closed.',
      });
      expect(() => assertAssetTradable(krxAsset, midday)).toThrow(
        MarketHoursError,
      );
      // Same instant: US and crypto stay unaffected by the KRX override.
      expect(
        getAssetTradingStatus(nasAsset, new Date('2026-07-13T15:00:00.000Z'))
          .tradable,
      ).toBe(true);
      expect(getAssetTradingStatus(cryptoAsset, midday)).toEqual({
        tradable: true,
      });
    });

    it('waits for a delayed CUSTOM open and allows trading afterwards', () => {
      applyMarketSessionOverrideSnapshot(
        [
          {
            market: 'KRX',
            localDate: '2026-07-13',
            overrideType: 'custom',
            openTime: '100000',
            closeTime: '153000',
            reason: 'delayed open',
          },
        ],
        new Date(),
      );

      expect(
        getAssetTradingStatus(krxAsset, new Date('2026-07-13T00:30:00.000Z')),
      ).toMatchObject({ tradable: false, reason: 'MARKET_CLOSED' });
      expect(
        getAssetTradingStatus(krxAsset, new Date('2026-07-13T01:30:00.000Z'))
          .tradable,
      ).toBe(true);
    });

    it('closes after a CUSTOM early close for US without touching KRX/crypto', () => {
      applyMarketSessionOverrideSnapshot(
        [
          {
            market: 'US',
            localDate: '2026-07-13',
            overrideType: 'custom',
            openTime: '093000',
            closeTime: '130000',
            reason: 'early close',
          },
        ],
        new Date(),
      );

      expect(
        getAssetTradingStatus(nasAsset, new Date('2026-07-13T16:59:00.000Z'))
          .tradable,
      ).toBe(true);
      expect(
        getAssetTradingStatus(nasAsset, new Date('2026-07-13T17:00:00.000Z')),
      ).toMatchObject({ tradable: false, reason: 'MARKET_CLOSED' });
      expect(
        getAssetTradingStatus(krxAsset, new Date('2026-07-13T03:00:00.000Z'))
          .tradable,
      ).toBe(true);
      expect(
        getAssetTradingStatus(
          cryptoAsset,
          new Date('2026-07-13T17:00:00.000Z'),
        ),
      ).toEqual({ tradable: true });
    });

    it('keeps calendar-unavailable distinguishable from a plain closure', () => {
      markMarketSessionOverrideStoreRequired();
      const unavailable = getAssetTradingStatus(
        krxAsset,
        new Date('2026-07-13T03:00:00.000Z'),
      );
      expect(unavailable).toMatchObject({
        tradable: false,
        reason: 'MARKET_CLOSED',
        message:
          'KRX market calendar has no data for this date; treating the day as not tradable.',
      });

      applyMarketSessionOverrideSnapshot([], new Date());
      const open = getAssetTradingStatus(
        krxAsset,
        new Date('2026-07-13T03:00:00.000Z'),
      );
      expect(open.tradable).toBe(true);
    });
  });
});
