import { resolveMarketSession } from '../../orders/market-calendar.policy';
import {
  formatZonedCursor,
  zonedDateTimeToUtc,
} from '../kis/candles/kis-candle-time';

const US_EASTERN_TIME_ZONE = 'America/New_York';

/**
 * US equity clock segments, classified with the shared exchange calendar
 * (holidays, early closes and DST via America/New_York). Used for coverage
 * evidence only — the app's price/order policy stays regular-session based.
 *
 * - pre_market: 04:00 ET → regular open
 * - regular: regular open → close (13:00 on early-close days)
 * - after_hours: close → 20:00 ET
 * - overnight: 20:00 → 04:00 ET around a trading date (Tiingo documents its
 *   consolidated feed as 04:00–20:00 ET; overnight is a separate BOATS product)
 * - non_trading_day: weekend/holiday local dates
 */
export type UsEquitySessionSegment =
  | 'pre_market'
  | 'regular'
  | 'after_hours'
  | 'overnight'
  | 'non_trading_day';

export const US_EQUITY_SESSION_SEGMENTS: readonly UsEquitySessionSegment[] = [
  'pre_market',
  'regular',
  'after_hours',
  'overnight',
  'non_trading_day',
];

export function classifyUsEquitySegment(at: Date): UsEquitySessionSegment {
  const localDate = formatZonedCursor(at, US_EASTERN_TIME_ZONE).date;
  const session = resolveMarketSession('US', localDate);
  if (!session) return 'non_trading_day';
  const time = at.getTime();
  if (time >= session.openTime.getTime() && time < session.closeTime.getTime())
    return 'regular';
  const preMarketOpen = zonedDateTimeToUtc(
    localDate,
    '040000',
    US_EASTERN_TIME_ZONE,
  );
  if (
    preMarketOpen &&
    time >= preMarketOpen.getTime() &&
    time < session.openTime.getTime()
  )
    return 'pre_market';
  const afterHoursClose = zonedDateTimeToUtc(
    localDate,
    '200000',
    US_EASTERN_TIME_ZONE,
  );
  if (
    afterHoursClose &&
    time >= session.closeTime.getTime() &&
    time < afterHoursClose.getTime()
  )
    return 'after_hours';
  return 'overnight';
}

/** America/New_York calendar date (YYYYMMDD) of an instant. */
export function usEasternDate(at: Date): string {
  return formatZonedCursor(at, US_EASTERN_TIME_ZONE).date;
}

/** YYYYMMDD → YYYY-MM-DD. */
export function dashedDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
