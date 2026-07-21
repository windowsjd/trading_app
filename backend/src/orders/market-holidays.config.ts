import {
  findCalendarSchedule,
  hasCalendarYear,
} from './market-calendar/market-calendar.registry';
import {
  findActiveMarketSessionOverride,
  isMarketSessionOverrideStoreReady,
} from './market-calendar/market-session-override.store';

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
 * Schedule lookup with the operator DB override layer applied on top of the
 * static per-year datasets. Precedence: active DB override > static calendar.
 * A 'regular' override cancels any static closure/session change (default
 * session times); 'closed' forces a full-day closure; 'custom' replaces the
 * session open/close. Overrides never grant calendar coverage — see
 * hasEffectiveMarketCalendarForDate.
 */
export function findEffectiveMarketSchedule(
  market: MarketHoliday['market'],
  holidayDate: string,
): MarketHoliday | null {
  const override = findActiveMarketSessionOverride(market, holidayDate);
  if (override) {
    return {
      market,
      holidayDate: override.localDate,
      name: override.reason,
      isFullDayClosed: override.overrideType === 'closed',
      openTimeOverride:
        override.overrideType === 'custom' ? override.openTime : null,
      closeTimeOverride:
        override.overrideType === 'custom' ? override.closeTime : null,
    };
  }
  return findMarketSchedule(market, holidayDate);
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

/**
 * Coverage gate for the effective (override-aware) calendar. Static coverage
 * is still the only source of per-year coverage — a DB override for a date in
 * an uncovered year never makes that year available. Additionally fails
 * closed while the override store is required but has not completed its first
 * successful load, so the app never silently trades on static-only data when
 * DB overrides may exist.
 */
export function hasEffectiveMarketCalendarForDate(
  market: MarketHoliday['market'],
  holidayDate: string,
): boolean {
  return (
    isMarketSessionOverrideStoreReady() &&
    hasMarketCalendarForDate(market, holidayDate)
  );
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
