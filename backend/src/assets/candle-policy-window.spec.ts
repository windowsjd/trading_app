import {
  findPreviousMarketSession,
  resolveMarketSession,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import { readCandleServingConfig } from './candle-serving.config';

/**
 * Design v2.1 §5.1–§5.4 (calc/krx_sessions.py §2): every domestic chart
 * window, at its worst query instant (the last instant of the query day) and
 * with the 4 h aggregation padding, must stay inside its managed range — the
 * 5m windows with ≥ 3 days to spare under the 45-day range, the 576-session
 * daily window under 875 days. Computed on the real KRX calendar datasets.
 */
const DAY_MS = 86_400_000;
const PADDING_MS = 4 * 60 * 60_000;
const KRX = { assetType: 'domestic_stock' as const, market: 'KRX' };

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Every KRX session of the calendar years with datasets, oldest first.
const sessions: MarketSessionWindow[] = [];
for (
  let day = Date.UTC(2024, 0, 1);
  day <= Date.UTC(2027, 11, 31);
  day += DAY_MS
) {
  const session = resolveMarketSession('KRX', isoDate(day).replace(/-/gu, ''));
  if (session) sessions.push(session);
}

/** Nth session strictly before `localDate` (the findPreviousMarketSession rule). */
function previousSession(localDate: string, n: number) {
  const index = sessions.findIndex((s) => s.localDate >= localDate);
  const before = index < 0 ? sessions.length : index;
  return before - n >= 0 ? sessions[before - n] : null;
}

/**
 * Query dates from the design date (2026-10-15) through the last calendar
 * dataset: only "now" is ever queried, so past dates cannot widen a live
 * window (the historical 2025-02-03 query would read 45.8 days: Christmas,
 * the year-end closure and Seollal in one 24-session span). Adding a newer
 * calendar year extends this scan and re-checks the invariant (§5.2).
 */
const LAST_CALENDAR_DAY = Date.parse(
  `${sessions[sessions.length - 1].localDate}T00:00:00Z`,
);

function widestWindow(n: number, daily: boolean) {
  let widest = { ms: 0, queryDate: '' };
  let resolved = 0;
  for (
    let day = Date.UTC(2026, 9, 15);
    day <= LAST_CALENDAR_DAY;
    day += DAY_MS
  ) {
    const queryDate = isoDate(day);
    const anchor = previousSession(queryDate, n);
    if (!anchor) continue; // the anchor needs a pre-2024 calendar
    resolved += 1;
    const end = Date.parse(`${queryDate}T23:59:59.999+09:00`) + 1;
    const from = daily
      ? Date.parse(`${anchor.localDate}T00:00:00+09:00`)
      : anchor.openTime.getTime() - PADDING_MS;
    if (end - from > widest.ms) widest = { ms: end - from, queryDate };
  }
  return { ...widest, resolved };
}

describe('KRX chart policy windows vs managed ranges', () => {
  const config = readCandleServingConfig({});

  it('enumerates the same anchors as findPreviousMarketSession', () => {
    for (const [queryDate, n] of [
      ['2026-10-15', 24],
      ['2027-10-21', 24],
      ['2026-10-15', 576],
      ['2025-01-02', 3],
    ] as const) {
      const reference = new Date(`${queryDate}T12:00:00+09:00`);
      expect(previousSession(queryDate, n)?.localDate).toBe(
        findPreviousMarketSession(KRX, reference, n)?.localDate,
      );
    }
  });

  it('keeps the 1h 24-session source window ≥ 3 days inside the managed 5m range', () => {
    const widest = widestWindow(24, false);
    // calc/krx_sessions.out.txt §2: 41.79 days (Chuseok + Hangul Day block),
    // reached by every query from 2027-10-12 to 2027-10-21 (the script
    // reports the last tied day, this scan the first).
    expect(
      widest.queryDate >= '2027-10-12' && widest.queryDate <= '2027-10-21',
    ).toBe(true);
    expect(Math.round((widest.ms / DAY_MS) * 100) / 100).toBe(41.79);
    expect(widest.ms + 3 * DAY_MS <= config.maxManagedFiveMinuteRangeMs).toBe(
      true,
    );
  });

  it.each([
    [3, 13],
    [6, 18],
    [12, 26],
  ])(
    'keeps the %s-session 5m-family window under %s days',
    (n, ceilingDays) => {
      const widest = widestWindow(n, false);
      expect(widest.ms < ceilingDays * DAY_MS).toBe(true);
      expect(widest.ms + 3 * DAY_MS <= config.maxManagedFiveMinuteRangeMs).toBe(
        true,
      );
    },
  );

  it('keeps the 576-session daily window inside the 875-day KRX daily range', () => {
    const widest = widestWindow(576, true);
    expect(widest.resolved > 0).toBe(true);
    expect(widest.ms <= config.maxManagedKrxDailyRangeMs).toBe(true);
    // ~867.6 days at most (design v2.1 §5.1), far beyond the generic 365.
    expect(widest.ms > 860 * DAY_MS).toBe(true);
  });
});
