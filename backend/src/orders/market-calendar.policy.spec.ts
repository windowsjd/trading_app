jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
}));

import { AssetType } from '../generated/prisma/client';
import {
  findLastMarketSessionOfWeek,
  findLatestCompletedMarketSession,
  findPreviousMarketSession,
  inspectMarketSessionsInRange,
  isLastMarketSessionOfWeek,
  resolveMarketSession,
  resolveRegularSessionForEvent,
  resolveStockMarketDataUpperBound,
  resolveStockMarketSessionState,
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

  it('finds previous KRX sessions across the July 17 holiday and weekend', () => {
    const asset = { assetType: AssetType.domestic_stock, market: 'KRX' };
    expect(
      findPreviousMarketSession(asset, new Date('2026-07-20T03:00:00.000Z'), 1),
    ).toMatchObject({
      localDate: '2026-07-16',
      openTime: new Date('2026-07-16T00:00:00.000Z'),
    });
    expect(
      findPreviousMarketSession(asset, new Date('2026-07-20T03:00:00.000Z'), 2)
        ?.localDate,
    ).toBe('2026-07-15');
  });

  it('uses the actual delayed open for a previous-session anchor', () => {
    expect(
      findPreviousMarketSession(
        { assetType: AssetType.domestic_stock, market: 'KRX' },
        new Date('2026-01-05T03:00:00.000Z'),
        1,
      ),
    ).toMatchObject({
      localDate: '2026-01-02',
      openTime: new Date('2026-01-02T01:00:00.000Z'),
    });
  });

  it('resolves open/closed state and provider upper bound per market', () => {
    const krx = { assetType: AssetType.domestic_stock, market: 'KRX' };
    expect(
      resolveStockMarketSessionState(krx, new Date('2026-07-16T03:00:00.000Z'))
        ?.state,
    ).toBe('open');
    expect(
      resolveStockMarketDataUpperBound(
        krx,
        new Date('2026-07-18T03:00:00.000Z'),
      ),
    ).toEqual(new Date('2026-07-16T06:30:00.000Z'));
    expect(
      resolveStockMarketSessionState(krx, new Date('2028-01-04T03:00:00.000Z'))
        ?.state,
    ).toBe('calendar_unavailable');
  });

  it('confirms holiday-only ranges without inferring from provider emptiness', () => {
    expect(
      inspectMarketSessionsInRange(
        { assetType: AssetType.us_stock, market: 'NAS' },
        new Date('2026-07-03T04:00:00.000Z'),
        new Date('2026-07-04T04:00:00.000Z'),
      ),
    ).toEqual({ calendarCovered: true, hasTradingSession: false });
    expect(
      inspectMarketSessionsInRange(
        { assetType: AssetType.us_stock, market: 'NAS' },
        new Date('2028-07-03T04:00:00.000Z'),
        new Date('2028-07-04T04:00:00.000Z'),
      ).calendarCovered,
    ).toBe(false);
  });

  it('finds the last real session in weeks whose Friday is closed', () => {
    const krxLast = findLastMarketSessionOfWeek('KRX', '2026-07-17');
    expect(krxLast?.localDate).toBe('2026-07-16');
    expect(krxLast && isLastMarketSessionOfWeek(krxLast)).toBe(true);

    const usLast = findLastMarketSessionOfWeek('US', '2026-07-03');
    expect(usLast?.localDate).toBe('2026-07-02');
    expect(usLast && isLastMarketSessionOfWeek(usLast)).toBe(true);
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

  it('applies the registry US early close on Christmas Eve 2026', () => {
    expect(resolveMarketSession('US', '20261224')).toMatchObject({
      closeTime: new Date('2026-12-24T18:00:00.000Z'),
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
