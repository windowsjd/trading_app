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

  it('treats real 2026 exchange holidays as closed via the registry', () => {
    // KRX: local-election day (Wed) and Constitution Day (Fri).
    expect(resolveMarketSession('KRX', '20260603')).toBeNull();
    expect(resolveMarketSession('KRX', '20260717')).toBeNull();
    // US: Independence Day observed Friday July 3, 2026.
    expect(resolveMarketSession('US', '20260703')).toBeNull();
    // A regular Monday still resolves.
    expect(resolveMarketSession('KRX', '20260713')).not.toBeNull();
  });

  it('applies the registry US early close on the day after Thanksgiving 2026', () => {
    const session = resolveMarketSession('US', '20261127');
    expect(session).toMatchObject({
      closeTime: new Date('2026-11-27T18:00:00.000Z'),
      earlyClose: true,
    });
  });

  it('shifts the whole KRX session on CSAT day 2026', () => {
    const session = resolveMarketSession('KRX', '20261119');
    expect(session).toMatchObject({
      openTime: new Date('2026-11-19T01:00:00.000Z'),
      closeTime: new Date('2026-11-19T07:30:00.000Z'),
    });
  });

  it('spans the year boundary: closed Dec 31 2026 and Jan 1 2027, delayed open Jan 4 2027', () => {
    expect(resolveMarketSession('KRX', '20261231')).toBeNull();
    expect(resolveMarketSession('KRX', '20270101')).toBeNull();
    expect(resolveMarketSession('US', '20270101')).toBeNull();
    expect(resolveMarketSession('KRX', '20270104')?.openTime).toEqual(
      new Date('2027-01-04T01:00:00.000Z'),
    );
  });

  it('keeps US DST behavior across the 2027 spring transition', () => {
    // 2027 DST starts Sunday March 14: EST open on Mar 12, EDT open on Mar 15.
    expect(resolveMarketSession('US', '20270312')?.openTime).toEqual(
      new Date('2027-03-12T14:30:00.000Z'),
    );
    expect(resolveMarketSession('US', '20270315')?.openTime).toEqual(
      new Date('2027-03-15T13:30:00.000Z'),
    );
  });

  it('fails safe on dates in years without an audited calendar dataset', () => {
    expect(resolveMarketSession('KRX', '20280104')).toBeNull();
    expect(resolveMarketSession('US', '20280104')).toBeNull();
    expect(resolveMarketSession('KRX', '20250707')).toBeNull();
    expect(
      resolveRegularSessionForEvent(
        { assetType: AssetType.domestic_stock, market: 'KRX' },
        new Date('2028-01-04T01:00:00.000Z'),
      ),
    ).toBeNull();
  });
});
