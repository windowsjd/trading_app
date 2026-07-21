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
import {
  applyMarketSessionOverrideSnapshot,
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from './market-calendar/market-session-override.store';

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
    expect(resolveMarketSession('KRX', '20240705')).toBeNull();
    expect(
      resolveRegularSessionForEvent(
        { assetType: AssetType.domestic_stock, market: 'KRX' },
        new Date('2028-01-04T01:00:00.000Z'),
      ),
    ).toBeNull();
  });

  it('treats real 2025 exchange holidays as closed via the registry', () => {
    // KRX: temporary holiday (Mon before Seollal), presidential-election
    // day (Tue), Chuseok substitute holiday (Wed), year-end closure (Wed).
    expect(resolveMarketSession('KRX', '20250127')).toBeNull();
    expect(resolveMarketSession('KRX', '20250603')).toBeNull();
    expect(resolveMarketSession('KRX', '20251008')).toBeNull();
    expect(resolveMarketSession('KRX', '20251231')).toBeNull();
    // US: National Day of Mourning for President Carter (Thu) and
    // Independence Day (Fri).
    expect(resolveMarketSession('US', '20250109')).toBeNull();
    expect(resolveMarketSession('US', '20250704')).toBeNull();
    // Regular trading days resolve with standard UTC session instants.
    expect(resolveMarketSession('KRX', '20250707')).toMatchObject({
      openTime: new Date('2025-07-07T00:00:00.000Z'),
      closeTime: new Date('2025-07-07T06:30:00.000Z'),
    });
    expect(resolveMarketSession('US', '20250707')).toMatchObject({
      openTime: new Date('2025-07-07T13:30:00.000Z'),
      closeTime: new Date('2025-07-07T20:00:00.000Z'),
    });
    // 2025-10-10 was NOT designated a temporary holiday.
    expect(resolveMarketSession('KRX', '20251010')).not.toBeNull();
  });

  it('resolves 2025 KRX session overrides to their real UTC instants', () => {
    // 2025-01-02 opening day: 10:00 delayed open, regular 15:30 close.
    expect(resolveMarketSession('KRX', '20250102')).toMatchObject({
      openTime: new Date('2025-01-02T01:00:00.000Z'),
      closeTime: new Date('2025-01-02T06:30:00.000Z'),
      earlyClose: false,
    });
    // CSAT day 2025-11-13: whole session shifted to 10:00–16:30 KST.
    expect(resolveMarketSession('KRX', '20251113')).toMatchObject({
      openTime: new Date('2025-11-13T01:00:00.000Z'),
      closeTime: new Date('2025-11-13T07:30:00.000Z'),
    });
  });

  it('resolves 2025 US early closes with the correct EDT/EST offsets', () => {
    // Jul 3 is EDT (UTC-4): 13:00 ET close = 17:00Z.
    expect(resolveMarketSession('US', '20250703')).toMatchObject({
      openTime: new Date('2025-07-03T13:30:00.000Z'),
      closeTime: new Date('2025-07-03T17:00:00.000Z'),
      earlyClose: true,
    });
    // Nov 28 and Dec 24 are EST (UTC-5) after DST ended Nov 2: 18:00Z.
    expect(resolveMarketSession('US', '20251128')).toMatchObject({
      closeTime: new Date('2025-11-28T18:00:00.000Z'),
      earlyClose: true,
    });
    expect(resolveMarketSession('US', '20251224')).toMatchObject({
      closeTime: new Date('2025-12-24T18:00:00.000Z'),
      earlyClose: true,
    });
  });

  it('keeps US DST behavior across the 2025 spring and fall transitions', () => {
    // DST started Sunday 2025-03-09: EST open Fri Mar 7, EDT open Mon Mar 10.
    expect(resolveMarketSession('US', '20250307')?.openTime).toEqual(
      new Date('2025-03-07T14:30:00.000Z'),
    );
    expect(resolveMarketSession('US', '20250310')?.openTime).toEqual(
      new Date('2025-03-10T13:30:00.000Z'),
    );
    // DST ended Sunday 2025-11-02: EDT open Fri Oct 31, EST open Mon Nov 3.
    expect(resolveMarketSession('US', '20251031')?.openTime).toEqual(
      new Date('2025-10-31T13:30:00.000Z'),
    );
    expect(resolveMarketSession('US', '20251103')?.openTime).toEqual(
      new Date('2025-11-03T14:30:00.000Z'),
    );
  });

  it('finds previous KRX sessions across the 2025→2026 year boundary', () => {
    const asset = { assetType: AssetType.domestic_stock, market: 'KRX' };
    // Reference: first 2026 trading day (Fri Jan 2). The previous session
    // skips Jan 1 (holiday) and Dec 31 (year-end closure) back to Dec 30.
    const reference = new Date('2026-01-02T02:00:00.000Z');
    expect(findPreviousMarketSession(asset, reference, 1)).toMatchObject({
      localDate: '2025-12-30',
      openTime: new Date('2025-12-30T00:00:00.000Z'),
      closeTime: new Date('2025-12-30T06:30:00.000Z'),
    });
    expect(findPreviousMarketSession(asset, reference, 2)).toMatchObject({
      localDate: '2025-12-29',
      openTime: new Date('2025-12-29T00:00:00.000Z'),
    });
    // From the second 2026 session, prev1 is the delayed-open Jan 2 session
    // with its REAL 10:00 open, and prev2 crosses into 2025.
    const secondDay = new Date('2026-01-05T03:00:00.000Z');
    expect(findPreviousMarketSession(asset, secondDay, 1)).toMatchObject({
      localDate: '2026-01-02',
      openTime: new Date('2026-01-02T01:00:00.000Z'),
    });
    expect(findPreviousMarketSession(asset, secondDay, 2)).toMatchObject({
      localDate: '2025-12-30',
      openTime: new Date('2025-12-30T00:00:00.000Z'),
    });
  });

  it('finds previous US sessions across the 2025→2026 year boundary', () => {
    const asset = { assetType: AssetType.us_stock, market: 'NAS' };
    // Reference: first 2026 US trading day (Fri Jan 2). Dec 31 2025 was a
    // regular full session (no early close), Jan 1 2026 a holiday.
    const reference = new Date('2026-01-02T15:00:00.000Z');
    expect(findPreviousMarketSession(asset, reference, 1)).toMatchObject({
      localDate: '2025-12-31',
      openTime: new Date('2025-12-31T14:30:00.000Z'),
      closeTime: new Date('2025-12-31T21:00:00.000Z'),
      earlyClose: false,
    });
    expect(findPreviousMarketSession(asset, reference, 2)).toMatchObject({
      localDate: '2025-12-30',
      openTime: new Date('2025-12-30T14:30:00.000Z'),
    });
  });

  it('spans the 2025→2026 boundary for latest-completed and range inspection', () => {
    const krx = { assetType: AssetType.domestic_stock, market: 'KRX' };
    // At 2026-01-02 09:30 KST (00:30Z) the delayed 10:00 open has not
    // happened yet, so the latest COMPLETED session is 2025-12-30.
    expect(
      findLatestCompletedMarketSession(
        krx,
        new Date('2026-01-02T00:30:00.000Z'),
        10,
      )?.localDate,
    ).toBe('2025-12-30');
    // The year-end closure block (Dec 31 → Jan 1) is a confirmed no-session
    // range, NOT a coverage gap.
    expect(
      inspectMarketSessionsInRange(
        krx,
        new Date('2025-12-30T15:00:00.000Z'),
        new Date('2026-01-01T15:00:00.000Z'),
      ),
    ).toEqual({ calendarCovered: true, hasTradingSession: false });
    // A range spanning the boundary with real sessions on both sides.
    expect(
      inspectMarketSessionsInRange(
        krx,
        new Date('2025-12-29T15:00:00.000Z'),
        new Date('2026-01-05T15:00:00.000Z'),
      ),
    ).toEqual({ calendarCovered: true, hasTradingSession: true });
  });
});

describe('operator market session overrides (DB layer precedence)', () => {
  const krx = { assetType: AssetType.domestic_stock, market: 'KRX' };
  const us = { assetType: AssetType.us_stock, market: 'NAS' };

  const seed = (
    entries: readonly {
      market: 'KRX' | 'US';
      localDate: string;
      overrideType: 'regular' | 'closed' | 'custom';
      openTime?: string | null;
      closeTime?: string | null;
    }[],
  ) => {
    applyMarketSessionOverrideSnapshot(
      entries.map((entry) => ({
        market: entry.market,
        localDate: entry.localDate,
        overrideType: entry.overrideType,
        openTime: entry.openTime ?? null,
        closeTime: entry.closeTime ?? null,
        reason: 'test override',
      })),
      new Date('2026-07-01T00:00:00.000Z'),
    );
  };

  afterEach(() => {
    resetMarketSessionOverrideStoreForTest();
  });

  it('a CLOSED override turns a static regular day into a full closure', () => {
    // 2026-07-13 is a regular KRX Monday.
    expect(resolveMarketSession('KRX', '20260713')).not.toBeNull();
    seed([{ market: 'KRX', localDate: '2026-07-13', overrideType: 'closed' }]);

    expect(resolveMarketSession('KRX', '20260713')).toBeNull();
    const state = resolveStockMarketSessionState(
      krx,
      new Date('2026-07-13T03:00:00.000Z'), // midday KST
    );
    expect(state?.state).toBe('closed');
    // The closure is a confirmed no-session day, never a coverage gap.
    expect(
      inspectMarketSessionsInRange(
        krx,
        new Date('2026-07-12T15:00:00.000Z'),
        new Date('2026-07-13T15:00:00.000Z'),
      ),
    ).toEqual({ calendarCovered: true, hasTradingSession: false });
  });

  it('a CUSTOM override delays the open: closed before, open after, same close', () => {
    seed([
      {
        market: 'KRX',
        localDate: '2026-07-13',
        overrideType: 'custom',
        openTime: '100000',
        closeTime: '153000',
      },
    ]);

    const session = resolveMarketSession('KRX', '20260713');
    expect(session).toMatchObject({
      openTime: new Date('2026-07-13T01:00:00.000Z'),
      closeTime: new Date('2026-07-13T06:30:00.000Z'),
    });
    expect(
      resolveStockMarketSessionState(krx, new Date('2026-07-13T00:30:00.000Z'))
        ?.state,
    ).toBe('closed');
    expect(
      resolveStockMarketSessionState(krx, new Date('2026-07-13T01:30:00.000Z'))
        ?.state,
    ).toBe('open');
  });

  it('a REGULAR override restores a static full-day closure to the default session', () => {
    // 2026-01-01 is a static KRX holiday.
    expect(resolveMarketSession('KRX', '20260101')).toBeNull();
    seed([{ market: 'KRX', localDate: '2026-01-01', overrideType: 'regular' }]);

    expect(resolveMarketSession('KRX', '20260101')).toMatchObject({
      openTime: new Date('2026-01-01T00:00:00.000Z'),
      closeTime: new Date('2026-01-01T06:30:00.000Z'),
      earlyClose: false,
    });
  });

  it('a CUSTOM override replaces a static session-time override', () => {
    // Static: US 2026-11-27 closes early at 13:00 ET. The DB override wins.
    expect(resolveMarketSession('US', '20261127')?.closeTime).toEqual(
      new Date('2026-11-27T18:00:00.000Z'),
    );
    seed([
      {
        market: 'US',
        localDate: '2026-11-27',
        overrideType: 'custom',
        openTime: '100000',
        closeTime: '140000',
      },
    ]);

    expect(resolveMarketSession('US', '20261127')).toMatchObject({
      openTime: new Date('2026-11-27T15:00:00.000Z'),
      closeTime: new Date('2026-11-27T19:00:00.000Z'),
    });
  });

  it('an override in a year without a static dataset never grants coverage', () => {
    seed([{ market: 'KRX', localDate: '2028-03-02', overrideType: 'regular' }]);

    expect(resolveMarketSession('KRX', '20280302')).toBeNull();
    expect(
      resolveStockMarketSessionState(krx, new Date('2028-03-02T03:00:00.000Z')),
    ).toMatchObject({ state: 'calendar_unavailable' });
  });

  it('prev_open/prev2_open keep their session-count meaning across a delayed open', () => {
    seed([
      {
        market: 'KRX',
        localDate: '2026-07-15',
        overrideType: 'custom',
        openTime: '110000',
        closeTime: '153000',
      },
    ]);

    // Reference Thursday 2026-07-16: one session back is the delayed
    // Wednesday session with its REAL open; two back is Tuesday. The delayed
    // open never pushes the range an extra session into the past.
    const reference = new Date('2026-07-16T03:00:00.000Z');
    expect(findPreviousMarketSession(krx, reference, 1)).toMatchObject({
      localDate: '2026-07-15',
      openTime: new Date('2026-07-15T02:00:00.000Z'),
    });
    expect(findPreviousMarketSession(krx, reference, 2)).toMatchObject({
      localDate: '2026-07-14',
      openTime: new Date('2026-07-14T00:00:00.000Z'),
    });
  });

  it('KRX overrides never affect US sessions and vice versa', () => {
    seed([
      { market: 'KRX', localDate: '2026-07-13', overrideType: 'closed' },
      {
        market: 'US',
        localDate: '2026-07-14',
        overrideType: 'custom',
        openTime: '110000',
        closeTime: '160000',
      },
    ]);

    // KRX closure leaves the same-day US session untouched.
    expect(resolveMarketSession('US', '20260713')).toMatchObject({
      openTime: new Date('2026-07-13T13:30:00.000Z'),
    });
    // US delayed open leaves the same-day KRX session untouched.
    expect(resolveMarketSession('KRX', '20260714')).toMatchObject({
      openTime: new Date('2026-07-14T00:00:00.000Z'),
    });
    expect(
      resolveStockMarketSessionState(us, new Date('2026-07-13T15:00:00.000Z'))
        ?.state,
    ).toBe('open');
  });

  it('a Friday CLOSED override moves the last session of the week to Thursday', () => {
    seed([{ market: 'KRX', localDate: '2026-07-10', overrideType: 'closed' }]);

    expect(findLastMarketSessionOfWeek('KRX', '2026-07-08')?.localDate).toBe(
      '2026-07-09',
    );
  });

  it('an early-close override ends the session (and weekly close) at the real close', () => {
    seed([
      {
        market: 'KRX',
        localDate: '2026-07-10',
        overrideType: 'custom',
        openTime: '090000',
        closeTime: '120000',
      },
    ]);

    const session = resolveMarketSession('KRX', '20260710');
    expect(session).toMatchObject({
      closeTime: new Date('2026-07-10T03:00:00.000Z'),
      earlyClose: true,
    });
    // Weekly last-session anchor uses the overridden Friday close.
    expect(findLastMarketSessionOfWeek('KRX', '2026-07-08')).toMatchObject({
      localDate: '2026-07-10',
      closeTime: new Date('2026-07-10T03:00:00.000Z'),
    });
    // Early close: open at 11:59 KST+3h? (02:59Z) and closed at 03:00Z.
    expect(
      resolveStockMarketSessionState(krx, new Date('2026-07-10T02:59:00.000Z'))
        ?.state,
    ).toBe('open');
    expect(
      resolveStockMarketSessionState(krx, new Date('2026-07-10T03:00:00.000Z'))
        ?.state,
    ).toBe('closed');
  });

  it('fails closed while the override store is required but not yet loaded', () => {
    markMarketSessionOverrideStoreRequired();

    expect(resolveMarketSession('KRX', '20260713')).toBeNull();
    expect(
      resolveStockMarketSessionState(krx, new Date('2026-07-13T03:00:00.000Z')),
    ).toMatchObject({ state: 'calendar_unavailable' });

    // After the first successful load the calendar serves normally again.
    applyMarketSessionOverrideSnapshot([], new Date());
    expect(resolveMarketSession('KRX', '20260713')).not.toBeNull();
  });

  it('an injected scheduleLookup still bypasses the store (test seam preserved)', () => {
    seed([{ market: 'KRX', localDate: '2026-07-13', overrideType: 'closed' }]);
    // Explicit lookup injection ignores both coverage gating and the store.
    expect(resolveMarketSession('KRX', '20260713', () => null)).not.toBeNull();
  });
});
