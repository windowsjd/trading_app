import {
  findCalendarSchedule,
  hasCalendarYear,
} from './market-calendar/market-calendar.registry';

/**
 * Backwards-compatible lookup API over the versioned market calendar
 * registry (src/orders/market-calendar). The previous hard-coded test
 * holiday list has been replaced by audited per-year datasets; see
 * market-calendar/data/* for sources and versions.
 */
export type MarketHoliday = {
  market: 'KRX' | 'US';
  holidayDate: string;
  name: string;
  isFullDayClosed: boolean;
  openTimeOverride?: string | null;
  closeTimeOverride?: string | null;
};

/** Returns only full-day closures. */
export function findMarketHoliday(
  market: MarketHoliday['market'],
  holidayDate: string,
): MarketHoliday | null {
  const schedule = findCalendarSchedule(market, holidayDate);
  if (!schedule || !schedule.isFullDayClosed) return null;
  return toMarketHoliday(market, schedule);
}

/** Returns full-day closures and early/open-late session overrides. */
export function findMarketSchedule(
  market: MarketHoliday['market'],
  holidayDate: string,
): MarketHoliday | null {
  const schedule = findCalendarSchedule(market, holidayDate);
  return schedule ? toMarketHoliday(market, schedule) : null;
}

/**
 * Fail-safe guard: a date whose year has no calendar dataset must never be
 * assumed to be a regular trading day.
 */
export function hasMarketCalendarForDate(
  market: MarketHoliday['market'],
  holidayDate: string,
): boolean {
  const year = Number(holidayDate.slice(0, 4));
  return Number.isInteger(year) && hasCalendarYear(market, year);
}

function toMarketHoliday(
  market: MarketHoliday['market'],
  schedule: {
    date: string;
    name: string;
    isFullDayClosed: boolean;
    openTimeOverride?: string | null;
    closeTimeOverride?: string | null;
  },
): MarketHoliday {
  return {
    market,
    holidayDate: schedule.date,
    name: schedule.name,
    isFullDayClosed: schedule.isFullDayClosed,
    openTimeOverride: schedule.openTimeOverride ?? null,
    closeTimeOverride: schedule.closeTimeOverride ?? null,
  };
}
