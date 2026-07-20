import type { AssetType } from '../generated/prisma/client';
import {
  getZonedParts,
  zonedDateTimeToUtc,
} from '../providers/kis/candles/kis-candle-time';
import {
  findMarketSchedule,
  hasMarketCalendarForDate,
  type MarketHoliday,
} from './market-holidays.config';

export type MarketCalendarAsset = {
  assetType: AssetType;
  market: string;
};

export type MarketSessionWindow = {
  market: 'KRX' | 'US';
  localDate: string;
  timeZone: string;
  openTime: Date;
  closeTime: Date;
  earlyClose: boolean;
};

export type StockMarketSessionState =
  | {
      state: 'open';
      market: 'KRX' | 'US';
      currentSession: MarketSessionWindow;
      latestCompletedSession: MarketSessionWindow | null;
    }
  | {
      state: 'closed';
      market: 'KRX' | 'US';
      currentSession: MarketSessionWindow | null;
      latestCompletedSession: MarketSessionWindow | null;
    }
  | {
      state: 'calendar_unavailable';
      market: 'KRX' | 'US';
      currentSession: null;
      latestCompletedSession: null;
    };

export type MarketSessionRangeInspection = {
  calendarCovered: boolean;
  hasTradingSession: boolean;
};

const SESSION_POLICY = {
  KRX: {
    timeZone: 'Asia/Seoul',
    open: '090000',
    close: '153000',
  },
  US: {
    timeZone: 'America/New_York',
    open: '093000',
    close: '160000',
  },
} as const;

export function resolveRegularSessionForEvent(
  asset: MarketCalendarAsset,
  eventTime: Date,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionWindow | null {
  const market = resolveCalendarMarket(asset);
  if (!market || Number.isNaN(eventTime.getTime())) return null;
  const policy = SESSION_POLICY[market];
  const parts = getZonedParts(eventTime, policy.timeZone);
  const localDate = compactDate(parts.year, parts.month, parts.day);
  const session = resolveMarketSession(market, localDate, scheduleLookup);
  if (!session) return null;
  const timestamp = eventTime.getTime();
  return timestamp >= session.openTime.getTime() &&
    timestamp < session.closeTime.getTime()
    ? session
    : null;
}

export function resolveMarketSession(
  market: 'KRX' | 'US',
  localDate: string,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionWindow | null {
  if (!/^\d{8}$/u.test(localDate)) return null;
  const policy = SESSION_POLICY[market];
  const midday = zonedDateTimeToUtc(localDate, '120000', policy.timeZone);
  if (!midday) return null;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: policy.timeZone,
    weekday: 'short',
  }).format(midday);
  if (weekday === 'Sat' || weekday === 'Sun') return null;

  const dashedDate = `${localDate.slice(0, 4)}-${localDate.slice(4, 6)}-${localDate.slice(6, 8)}`;
  // Fail-safe: a date in a year without an audited calendar dataset is never
  // assumed to be a regular trading day. Readiness surfaces the missing year
  // (MARKET_CALENDAR_COVERAGE_MISSING) so operators add the dataset.
  if (
    scheduleLookup === findMarketSchedule &&
    !hasMarketCalendarForDate(market, dashedDate)
  ) {
    return null;
  }
  const override = scheduleLookup(market, dashedDate);
  if (override?.isFullDayClosed) return null;
  const openText = parseOverrideTime(override?.openTimeOverride) ?? policy.open;
  const closeText =
    parseOverrideTime(override?.closeTimeOverride) ?? policy.close;
  const openTime = zonedDateTimeToUtc(localDate, openText, policy.timeZone);
  const closeTime = zonedDateTimeToUtc(localDate, closeText, policy.timeZone);
  if (!openTime || !closeTime || openTime.getTime() >= closeTime.getTime()) {
    return null;
  }
  return {
    market,
    localDate: dashedDate,
    timeZone: policy.timeZone,
    openTime,
    closeTime,
    earlyClose: closeText !== policy.close,
  };
}

export function findLatestCompletedMarketSession(
  asset: MarketCalendarAsset,
  now: Date,
  maxLookbackDays: number,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionWindow | null {
  const market = resolveCalendarMarket(asset);
  if (!market || maxLookbackDays < 1) return null;
  const policy = SESSION_POLICY[market];
  const local = getZonedParts(now, policy.timeZone);
  const referenceDate = compactDate(local.year, local.month, local.day);
  if (
    scheduleLookup === findMarketSchedule &&
    !hasMarketCalendarForDate(market, dashed(referenceDate))
  ) {
    return null;
  }
  const localMidnight = Date.UTC(local.year, local.month - 1, local.day);
  for (let offset = 0; offset <= maxLookbackDays; offset += 1) {
    const candidate = new Date(localMidnight - offset * 86_400_000);
    const localDate = compactDate(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth() + 1,
      candidate.getUTCDate(),
    );
    const session = resolveMarketSession(market, localDate, scheduleLookup);
    if (session && session.closeTime.getTime() <= now.getTime()) return session;
  }
  return null;
}

/**
 * Resolves the Nth exchange session strictly before the reference's local
 * calendar date. The reference date itself is never counted, even after its
 * close; this is the chart `prev_open` / `prev2_open` meaning.
 */
export function findPreviousMarketSession(
  asset: MarketCalendarAsset,
  reference: Date,
  sessionsBack: number,
  maxLookbackDays = 370,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionWindow | null {
  const market = resolveCalendarMarket(asset);
  if (
    !market ||
    !Number.isSafeInteger(sessionsBack) ||
    sessionsBack < 1 ||
    !Number.isSafeInteger(maxLookbackDays) ||
    maxLookbackDays < sessionsBack ||
    Number.isNaN(reference.getTime())
  ) {
    return null;
  }

  const policy = SESSION_POLICY[market];
  const local = getZonedParts(reference, policy.timeZone);
  const referenceDate = compactDate(local.year, local.month, local.day);
  if (
    scheduleLookup === findMarketSchedule &&
    !hasMarketCalendarForDate(market, dashed(referenceDate))
  ) {
    return null;
  }
  const localMidnight = Date.UTC(local.year, local.month - 1, local.day);
  let remaining = sessionsBack;
  for (let offset = 1; offset <= maxLookbackDays; offset += 1) {
    const localDate = compactDateFromUtcMs(localMidnight - offset * 86_400_000);
    const session = resolveMarketSession(market, localDate, scheduleLookup);
    if (!session) continue;
    remaining -= 1;
    if (remaining === 0) return session;
  }
  return null;
}

/** Returns open/closed state for one stock market at an instant. */
export function resolveStockMarketSessionState(
  asset: MarketCalendarAsset,
  now: Date,
  maxLookbackDays = 370,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): StockMarketSessionState | null {
  const market = resolveCalendarMarket(asset);
  if (!market || Number.isNaN(now.getTime())) return null;
  const policy = SESSION_POLICY[market];
  const local = getZonedParts(now, policy.timeZone);
  const localDate = compactDate(local.year, local.month, local.day);
  const dashedDate = dashed(localDate);
  if (
    scheduleLookup === findMarketSchedule &&
    !hasMarketCalendarForDate(market, dashedDate)
  ) {
    return {
      state: 'calendar_unavailable',
      market,
      currentSession: null,
      latestCompletedSession: null,
    };
  }

  const currentSession = resolveMarketSession(
    market,
    localDate,
    scheduleLookup,
  );
  const nowMs = now.getTime();
  if (
    currentSession &&
    currentSession.openTime.getTime() <= nowMs &&
    nowMs < currentSession.closeTime.getTime()
  ) {
    return {
      state: 'open',
      market,
      currentSession,
      latestCompletedSession: findLatestCompletedMarketSession(
        asset,
        now,
        maxLookbackDays,
        scheduleLookup,
      ),
    };
  }

  return {
    state: 'closed',
    market,
    currentSession,
    latestCompletedSession: findLatestCompletedMarketSession(
      asset,
      now,
      maxLookbackDays,
      scheduleLookup,
    ),
  };
}

/**
 * Provider upper bound for a stock range. During a live session it is the
 * requested/current instant; otherwise it is the latest completed session
 * close. Missing calendar coverage returns null (fail closed).
 */
export function resolveStockMarketDataUpperBound(
  asset: MarketCalendarAsset,
  requestedTo: Date,
  now: Date = requestedTo,
  maxLookbackDays = 370,
): Date | null {
  if (Number.isNaN(requestedTo.getTime()) || Number.isNaN(now.getTime())) {
    return null;
  }
  const reference = new Date(Math.min(requestedTo.getTime(), now.getTime()));
  const state = resolveStockMarketSessionState(
    asset,
    reference,
    maxLookbackDays,
  );
  if (!state || state.state === 'calendar_unavailable') return null;
  return state.state === 'open'
    ? reference
    : (state.latestCompletedSession?.closeTime ?? null);
}

/**
 * Inspects whether any real exchange session overlaps a half-open instant
 * range. Calendar coverage is reported separately so uncovered years are
 * never mistaken for a confirmed holiday/weekend empty range.
 */
export function inspectMarketSessionsInRange(
  asset: MarketCalendarAsset,
  from: Date,
  to: Date,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionRangeInspection {
  const market = resolveCalendarMarket(asset);
  if (
    !market ||
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from.getTime() >= to.getTime()
  ) {
    return { calendarCovered: false, hasTradingSession: false };
  }
  const policy = SESSION_POLICY[market];
  const start = getZonedParts(from, policy.timeZone);
  const end = getZonedParts(new Date(to.getTime() - 1), policy.timeZone);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const endDay = Date.UTC(end.year, end.month - 1, end.day);
  for (let cursor = startDay; cursor <= endDay; cursor += 86_400_000) {
    const localDate = compactDateFromUtcMs(cursor);
    if (
      scheduleLookup === findMarketSchedule &&
      !hasMarketCalendarForDate(market, dashed(localDate))
    ) {
      return { calendarCovered: false, hasTradingSession: false };
    }
    const session = resolveMarketSession(market, localDate, scheduleLookup);
    if (
      session &&
      session.openTime.getTime() < to.getTime() &&
      session.closeTime.getTime() > from.getTime()
    ) {
      return { calendarCovered: true, hasTradingSession: true };
    }
  }
  return { calendarCovered: true, hasTradingSession: false };
}

/** Finds the exchange's final real session in the local ISO week. */
export function findLastMarketSessionOfWeek(
  market: 'KRX' | 'US',
  localDate: string,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionWindow | null {
  const compact = localDate.replace(/-/gu, '');
  const dateMs = compactDateToUtcMs(compact);
  if (dateMs === null) return null;
  if (
    scheduleLookup === findMarketSchedule &&
    !hasMarketCalendarForDate(market, dashed(compact))
  ) {
    return null;
  }
  const weekday = new Date(dateMs).getUTCDay();
  const monday = dateMs - ((weekday + 6) % 7) * 86_400_000;
  for (let offset = 6; offset >= 0; offset -= 1) {
    const session = resolveMarketSession(
      market,
      compactDateFromUtcMs(monday + offset * 86_400_000),
      scheduleLookup,
    );
    if (session) return session;
  }
  return null;
}

export function isLastMarketSessionOfWeek(
  session: MarketSessionWindow,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): boolean {
  return (
    findLastMarketSessionOfWeek(
      session.market,
      session.localDate,
      scheduleLookup,
    )?.localDate === session.localDate
  );
}

export function resolveCalendarMarket(
  asset: MarketCalendarAsset,
): 'KRX' | 'US' | null {
  if (asset.assetType === ('domestic_stock' as AssetType)) return 'KRX';
  if (asset.assetType === ('us_stock' as AssetType)) return 'US';
  const market = asset.market.trim().toUpperCase();
  if (['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(market)) return 'KRX';
  if (['NAS', 'NASDAQ', 'NYS', 'NYSE', 'AMS', 'AMEX'].includes(market)) {
    return 'US';
  }
  return null;
}

function parseOverrideTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/:/gu, '');
  return /^\d{6}$/u.test(compact) ? compact : null;
}

function compactDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}${month
    .toString()
    .padStart(2, '0')}${day.toString().padStart(2, '0')}`;
}

function compactDateFromUtcMs(value: number): string {
  const date = new Date(value);
  return compactDate(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function compactDateToUtcMs(value: string): number | null {
  if (!/^\d{8}$/u.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const result = Date.UTC(year, month - 1, day);
  const check = new Date(result);
  return check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
    ? result
    : null;
}

function dashed(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export type MarketScheduleLookup = (
  market: MarketHoliday['market'],
  holidayDate: string,
) => MarketHoliday | null;
