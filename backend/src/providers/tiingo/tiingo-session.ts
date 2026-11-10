import { resolveMarketSession } from '../../orders/market-calendar.policy';
import { findUsExtendedHoursWindow } from '../../orders/us-extended-hours.policy';
import { formatZonedCursor } from '../kis/candles/kis-candle-time';

const US_EASTERN_TIME_ZONE = 'America/New_York';

/**
 * US equity clock segments, classified with the shared exchange calendar
 * (holidays, early closes and DST via America/New_York) and the shared
 * extended-hours windows (orders/us-extended-hours.policy.ts).
 *
 * - pre_market: 04:00 ET → regular open
 * - regular: regular open → close (13:00 on early-close days)
 * - after_hours: close → 20:00 ET (17:00 ET on early-close days, when the
 *   exchanges' late sessions end)
 * - overnight: the rest of a trading date (Tiingo documents its consolidated
 *   feed as 04:00–20:00 ET; overnight is a separate BOATS product)
 * - non_trading_day: weekend/holiday local dates (and dates without calendar
 *   coverage, which are never assumed to trade)
 *
 * Only `regular` observations are stored under the regular source name;
 * `pre_market`/`after_hours` are stored under the extended source name when
 * US_STOCK_EXTENDED_HOURS_PRICE_ENABLED is on; the rest is never stored.
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
  return findUsExtendedHoursWindow(session, at)?.segment ?? 'overnight';
}

/** America/New_York calendar date (YYYYMMDD) of an instant. */
export function usEasternDate(at: Date): string {
  return formatZonedCursor(at, US_EASTERN_TIME_ZONE).date;
}

/** YYYYMMDD → YYYY-MM-DD. */
export function dashedDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
