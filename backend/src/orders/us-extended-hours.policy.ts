import type { AssetType } from '../generated/prisma/client';
import { zonedDateTimeToUtc } from '../providers/kis/candles/kis-candle-time';
import {
  resolveCalendarMarket,
  resolveStockMarketSessionState,
  type MarketSessionWindow,
  type StockMarketSessionState,
} from './market-calendar.policy';

/**
 * US extended trading hours around ONE regular session (2026-11-10), as New
 * York wall times of that session's date:
 *
 * - pre-market: 04:00 → the regular open,
 * - after-hours: the regular close → 20:00, or → 17:00 on a calendar early
 *   close (NYSE: the late sessions close at 17:00 on 13:00 early-close days).
 *
 * The regular session itself (holidays, early closes, operator overrides, DST)
 * always comes from the shared exchange calendar, so a day without a regular
 * session has no extended hours either, and a date without calendar coverage
 * is never assumed to have them (fail closed). This is the one definition of
 * these windows: Tiingo's segment classification, price selection and the
 * limit matcher all derive from it.
 */
export const US_PRE_MARKET_OPEN = '040000';
export const US_AFTER_HOURS_CLOSE = '200000';
export const US_EARLY_CLOSE_AFTER_HOURS_CLOSE = '170000';
const US_REGULAR_CLOSE = '160000';

export type UsExtendedHoursSegment = 'pre_market' | 'after_hours';

export type UsExtendedHoursWindow = {
  segment: UsExtendedHoursSegment;
  /** The regular session the window belongs to. */
  session: MarketSessionWindow;
  /** Inclusive. */
  startsAt: Date;
  /** Exclusive. */
  endsAt: Date;
};

export type UsExtendedHoursState =
  | { state: UsExtendedHoursSegment; window: UsExtendedHoursWindow }
  | { state: 'regular' | 'closed' | 'calendar_unavailable' };

type MarketAsset = { assetType: AssetType; market: string };

/** Pre-market and after-hours windows of one regular US session. */
export function usExtendedHoursWindows(session: MarketSessionWindow): {
  preMarket: UsExtendedHoursWindow | null;
  afterHours: UsExtendedHoursWindow | null;
} {
  if (session.market !== 'US') return { preMarket: null, afterHours: null };
  const localDate = session.localDate.replaceAll('-', '');
  const wallTime = (time: string) =>
    zonedDateTimeToUtc(localDate, time, session.timeZone);
  const preMarketOpen = wallTime(US_PRE_MARKET_OPEN);
  const regularClose = wallTime(US_REGULAR_CLOSE);
  const earlyClose =
    session.earlyClose &&
    regularClose !== null &&
    session.closeTime.getTime() < regularClose.getTime();
  const afterHoursClose = wallTime(
    earlyClose ? US_EARLY_CLOSE_AFTER_HOURS_CLOSE : US_AFTER_HOURS_CLOSE,
  );
  return {
    preMarket:
      preMarketOpen && preMarketOpen.getTime() < session.openTime.getTime()
        ? {
            segment: 'pre_market',
            session,
            startsAt: preMarketOpen,
            endsAt: session.openTime,
          }
        : null,
    afterHours:
      afterHoursClose && session.closeTime.getTime() < afterHoursClose.getTime()
        ? {
            segment: 'after_hours',
            session,
            startsAt: session.closeTime,
            endsAt: afterHoursClose,
          }
        : null,
  };
}

/** The extended window of `session` that contains `at`, if any. */
export function findUsExtendedHoursWindow(
  session: MarketSessionWindow | null,
  at: Date,
): UsExtendedHoursWindow | null {
  if (!session) return null;
  const time = at.getTime();
  const { preMarket, afterHours } = usExtendedHoursWindows(session);
  for (const window of [preMarket, afterHours]) {
    if (
      window &&
      time >= window.startsAt.getTime() &&
      time < window.endsAt.getTime()
    )
      return window;
  }
  return null;
}

/**
 * Extended-hours state of an already resolved US market state (no second
 * calendar lookup). `closed` covers overnight, weekends and holidays.
 */
export function usExtendedHoursStateFrom(
  marketState: StockMarketSessionState | null,
  now: Date,
): UsExtendedHoursState {
  if (!marketState || marketState.state === 'calendar_unavailable')
    return { state: 'calendar_unavailable' };
  if (marketState.state === 'open') return { state: 'regular' };
  const window = findUsExtendedHoursWindow(marketState.currentSession, now);
  return window ? { state: window.segment, window } : { state: 'closed' };
}

/** Null for anything that is not a US stock (the only scope, by policy). */
export function resolveUsExtendedHoursState(
  asset: MarketAsset,
  now: Date,
): UsExtendedHoursState | null {
  if (asset.assetType !== 'us_stock' || resolveCalendarMarket(asset) !== 'US')
    return null;
  return usExtendedHoursStateFrom(
    resolveStockMarketSessionState(asset, now),
    now,
  );
}

/** The current pre-market/after-hours window of a US stock, else null. */
export function resolveUsExtendedHoursWindow(
  asset: MarketAsset,
  now: Date,
): UsExtendedHoursWindow | null {
  const state = resolveUsExtendedHoursState(asset, now);
  return state && 'window' in state ? state.window : null;
}
