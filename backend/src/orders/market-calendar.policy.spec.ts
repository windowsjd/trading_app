jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
}));

import { AssetType } from '../generated/prisma/client';
import {
  findLatestCompletedMarketSession,
  resolveMarketSession,
  resolveRegularSessionForEvent,
} from './market-calendar.policy';

describe('market calendar policy', () => {
  it('anchors KRX to 09:00 Asia/Seoul and excludes the close boundary', () => {
    const asset = { assetType: AssetType.domestic_stock, market: 'KRX' };
    const session = resolveRegularSessionForEvent(
      asset,
      new Date('2026-07-13T00:00:00.000Z'),
    );
    expect(session).toMatchObject({
      openTime: new Date('2026-07-13T00:00:00.000Z'),
      closeTime: new Date('2026-07-13T06:30:00.000Z'),
    });
    expect(
      resolveRegularSessionForEvent(
        asset,
        new Date('2026-07-13T06:30:00.000Z'),
      ),
    ).toBeNull();
  });

  it('uses America/New_York DST for the 09:30 US anchor', () => {
    expect(resolveMarketSession('US', '20260109')?.openTime).toEqual(
      new Date('2026-01-09T14:30:00.000Z'),
    );
    expect(resolveMarketSession('US', '20260309')?.openTime).toEqual(
      new Date('2026-03-09T13:30:00.000Z'),
    );
  });

  it('honors full holidays and early-close overrides without synthetic sessions', () => {
    const holiday = () => ({
      market: 'US' as const,
      holidayDate: '2026-07-03',
      name: 'holiday',
      isFullDayClosed: true,
      openTimeOverride: null,
      closeTimeOverride: null,
    });
    expect(resolveMarketSession('US', '20260703', holiday)).toBeNull();

    const earlyClose = () => ({
      market: 'US' as const,
      holidayDate: '2026-11-27',
      name: 'early close',
      isFullDayClosed: false,
      openTimeOverride: null,
      closeTimeOverride: '13:00:00',
    });
    expect(resolveMarketSession('US', '20261127', earlyClose)).toMatchObject({
      closeTime: new Date('2026-11-27T18:00:00.000Z'),
      earlyClose: true,
    });
  });

  it('finds the prior completed session across a weekend', () => {
    const session = findLatestCompletedMarketSession(
      { assetType: AssetType.us_stock, market: 'NAS' },
      new Date('2026-07-13T12:00:00.000Z'),
      5,
    );
    expect(session?.localDate).toBe('2026-07-10');
  });
});
