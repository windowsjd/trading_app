jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal }, PrismaClient: class PrismaClient {} };
});
import { resolvePeriodWindowForDate } from '../kis/candles/kis-period-candle-normalizer.service';
import {
  TIINGO_BAR_SETTLE_MS,
  composeTiingoWeeklyCandles,
  firstUnsettledSlotStart,
  newYorkDate,
  normalizeTiingoDailyBars,
  normalizeTiingoFiveMinuteBars,
  sessionsWithoutBars,
  usSessionsBetween,
} from './tiingo-candle-normalizer';
import type { TiingoDailyBar, TiingoIntradayBar } from './tiingo.parser';

const bar = (iso: string, close = '100', volume: string | null = '10') =>
  ({
    openTime: new Date(iso),
    open: '99',
    high: '101',
    low: '98',
    close,
    volume,
  }) satisfies TiingoIntradayBar;

const daily = (
  date: string,
  close: string,
  adjusted = close,
): TiingoDailyBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1000',
  adjOpen: adjusted,
  adjHigh: adjusted,
  adjLow: adjusted,
  adjClose: adjusted,
  adjVolume: '1000',
  divCash: '0',
  splitFactor: '1',
});

const dayWindow = (date: string) =>
  resolvePeriodWindowForDate('US', date, '1d');
const weekWindow = (date: string) =>
  resolvePeriodWindowForDate('US', date, '1w');

describe('Tiingo US candle normalization (official mode)', () => {
  // Friday 2026-10-16, EDT: regular session 13:30–20:00 UTC; the range is
  // that New York date (04:00Z = local midnight).
  const sessions = usSessionsBetween(
    Date.parse('2026-10-16T04:00:00Z'),
    Date.parse('2026-10-17T04:00:00Z'),
  )!;

  it('enumerates calendar sessions in New York dates (DST-aware), failing closed without a calendar', () => {
    expect(sessions.map((session) => session.localDate)).toEqual([
      '2026-10-16',
    ]);
    // 00:00Z is still the previous New York date: that session is included.
    expect(
      usSessionsBetween(
        Date.parse('2026-10-16T00:00:00Z'),
        Date.parse('2026-10-17T00:00:00Z'),
      )!.map((session) => session.localDate),
    ).toEqual(['2026-10-15', '2026-10-16']);
    expect(sessions[0].openTime.toISOString()).toBe('2026-10-16T13:30:00.000Z');
    // EST after 2026-11-01; Thanksgiving closed, the day after closes 13:00.
    const thanksgiving = usSessionsBetween(
      Date.parse('2026-11-25T05:00:00Z'),
      Date.parse('2026-11-28T05:00:00Z'),
    )!;
    expect(thanksgiving.map((session) => session.localDate)).toEqual([
      '2026-11-25',
      '2026-11-27',
    ]);
    expect(thanksgiving[1].closeTime.toISOString()).toBe(
      '2026-11-27T18:00:00.000Z',
    );
    expect(
      usSessionsBetween(
        Date.parse('2023-06-01T00:00:00Z'),
        Date.parse('2023-06-03T00:00:00Z'),
      ),
    ).toBeNull();
    expect(newYorkDate(Date.parse('2026-10-17T03:59:00Z'))).toBe('2026-10-16');
  });

  it('stores settled regular-session 5m bars only: no pre/after-market, no unsettled bar, no invented volume', () => {
    const receivedAt = new Date(Date.parse('2026-10-16T14:00:00Z'));
    const result = normalizeTiingoFiveMinuteBars({
      bars: [
        bar('2026-10-16T13:25:00Z'), // pre-market
        bar('2026-10-16T13:30:00Z', '100.5'),
        bar('2026-10-16T13:35:00Z'),
        bar('2026-10-16T13:47:00Z'), // off the 5m grid
        bar('2026-10-16T13:50:00Z', '100', null), // no volume
        bar('2026-10-16T13:55:00Z'), // ends 14:00, settles 14:02
        bar('2026-10-16T20:00:00Z'), // after hours
      ],
      sessions,
      from: new Date('2026-10-16T13:00:00Z'),
      to: new Date('2026-10-16T21:00:00Z'),
      receivedAt,
    });
    expect(result.candles.map((c) => c.openTime.toISOString())).toEqual([
      '2026-10-16T13:30:00.000Z',
      '2026-10-16T13:35:00.000Z',
    ]);
    expect(result).toMatchObject({
      accepted: 2,
      rejected: 2,
      outside: 2,
      notFinal: 1,
    });
    expect(result.candles[0]).toMatchObject({
      amount: null,
      isClosed: true,
      sourceUpdatedAt: receivedAt,
    });
    expect(
      [result.candles[0].close, result.candles[0].volume].map(String),
    ).toEqual(['100.5', '10']);
    // Coverage of this read stops at the first still-settling slot.
    expect(
      new Date(firstUnsettledSlotStart(sessions, receivedAt)!).toISOString(),
    ).toBe('2026-10-16T13:55:00.000Z');
    expect(
      firstUnsettledSlotStart(sessions, new Date('2026-10-16T20:02:00Z')),
    ).toBeNull();
    expect(result.candles[0].closeTime.toISOString()).toBe(
      '2026-10-16T13:35:00.000Z',
    );
    expect(TIINGO_BAR_SETTLE_MS).toBe(120_000);
  });

  it('ends an early-close session at 13:00 New York and flags a finished session without bars', () => {
    const friday = usSessionsBetween(
      Date.parse('2026-11-27T05:00:00Z'),
      Date.parse('2026-11-28T05:00:00Z'),
    )!;
    const receivedAt = new Date('2026-11-27T23:00:00Z');
    const result = normalizeTiingoFiveMinuteBars({
      bars: [bar('2026-11-27T17:55:00Z'), bar('2026-11-27T18:00:00Z')],
      sessions: friday,
      from: new Date('2026-11-27T05:00:00Z'),
      to: new Date('2026-11-28T05:00:00Z'),
      receivedAt,
    });
    expect(result.candles.map((c) => c.openTime.toISOString())).toEqual([
      '2026-11-27T17:55:00.000Z',
    ]);
    expect(
      sessionsWithoutBars({
        candles: [],
        sessions: friday,
        from: new Date('2026-11-27T05:00:00Z'),
        to: new Date('2026-11-28T05:00:00Z'),
        receivedAt,
      }),
    ).toEqual(['2026-11-27']);
    expect(
      sessionsWithoutBars({
        candles: result.candles,
        sessions: friday,
        from: new Date('2026-11-27T05:00:00Z'),
        to: new Date('2026-11-28T05:00:00Z'),
        receivedAt,
      }),
    ).toEqual([]);
  });

  it('stores end-of-day RAW OHLCV on the shared daily window; a non-session date is refused', () => {
    const receivedAt = new Date('2026-10-17T01:00:00Z');
    const result = normalizeTiingoDailyBars({
      bars: [
        daily('2026-10-15', '95', '47.5'),
        daily('2026-10-16', '96'),
        daily('2026-10-17', '97'), // Saturday: no session
      ],
      windowFor: dayWindow,
      from: new Date('2026-10-15T04:00:00Z'),
      to: new Date('2026-10-18T04:00:00Z'),
      receivedAt,
    });
    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.dates).toEqual(['2026-10-15', '2026-10-16']);
    const [first] = result.candles;
    // Raw close, never the adjusted 47.5.
    expect([first.open, first.close].map(String)).toEqual(['95', '95']);
    expect(first.openTime.toISOString()).toBe('2026-10-15T04:00:00.000Z');
    expect(first.closeTime.toISOString()).toBe('2026-10-16T04:00:00.000Z');
    expect(first.isClosed).toBe(true);
    // A daily row is never stored before its session closed.
    expect(
      normalizeTiingoDailyBars({
        bars: [daily('2026-10-16', '96')],
        windowFor: dayWindow,
        from: new Date('2026-10-15T04:00:00Z'),
        to: new Date('2026-10-18T04:00:00Z'),
        receivedAt: new Date('2026-10-16T19:00:00Z'),
      }).notFinal,
    ).toBe(1);
  });

  it('composes a closed week only when every session of it has its raw daily row', () => {
    const receivedAt = new Date('2026-11-30T12:00:00Z');
    const dates = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'];
    const rows = normalizeTiingoDailyBars({
      bars: dates.map((date, index) => ({
        ...daily(date, String(100 + index)),
        high: String(110 + index),
        low: String(90 - index),
      })),
      windowFor: dayWindow,
      from: new Date('2026-11-23T05:00:00Z'),
      to: new Date('2026-11-30T05:00:00Z'),
      receivedAt,
    });
    const sessionDatesOf = (week: { openTime: Date; closeTime: Date }) =>
      usSessionsBetween(week.openTime.getTime(), week.closeTime.getTime())?.map(
        (session) => session.localDate,
      ) ?? null;
    const daily4 = rows.candles.map((candle, index) => ({
      date: rows.dates[index],
      candle,
    }));
    const week = composeTiingoWeeklyCandles({
      daily: daily4,
      weekFor: weekWindow,
      sessionDatesOf,
      from: new Date('2026-11-23T05:00:00Z'),
      to: new Date('2026-11-30T05:00:00Z'),
      receivedAt,
    });
    // Thanksgiving week: four sessions, Monday-anchored New York window.
    expect(week.accepted).toBe(1);
    const composed = week.candles[0];
    expect(
      [
        composed.open,
        composed.high,
        composed.low,
        composed.close,
        composed.volume,
      ].map(String),
    ).toEqual(['100', '113', '87', '103', '4000']);
    expect(composed.isClosed).toBe(true);
    expect(week.candles[0].openTime.toISOString()).toBe(
      '2026-11-23T05:00:00.000Z',
    );
    // One missing session: the week is skipped, never filled.
    const partial = composeTiingoWeeklyCandles({
      daily: daily4.slice(1),
      weekFor: weekWindow,
      sessionDatesOf,
      from: new Date('2026-11-23T05:00:00Z'),
      to: new Date('2026-11-30T05:00:00Z'),
      receivedAt,
    });
    expect([partial.accepted, partial.incompleteWeeks]).toEqual([0, 1]);
    // The current week is not stored before its last session closed.
    expect(
      composeTiingoWeeklyCandles({
        daily: daily4,
        weekFor: weekWindow,
        sessionDatesOf,
        from: new Date('2026-11-23T05:00:00Z'),
        to: new Date('2026-11-30T05:00:00Z'),
        receivedAt: new Date('2026-11-27T17:00:00Z'),
      }).notFinal,
    ).toBe(1);
  });
});
