/**
 * Calendar fixture for tsx PostgreSQL runners. Import BEFORE product services.
 * Only calendar inputs are replaced: every caller still passes its own real
 * timestamp, including the post-lock PostgreSQL clock_timestamp(). No Date or
 * DB clock is mocked. Session/candle bounds and calendar-unavailable stay live.
 * Production weekend/holiday policy is tested separately without this fixture.
 */
import * as calendar from '../../src/orders/market-calendar.policy';
import { isMarketSessionOverrideStoreReady } from '../../src/orders/market-calendar/market-session-override.store';

type Market = 'KRX' | 'US';
const sessions = new Map<Market, calendar.MarketSessionWindow>();

export const tradingSessions = {
  set(
    now: Date,
    closeAt = new Date(now.getTime() + 86_400_000),
    markets: Market[] = ['KRX'],
  ) {
    for (const market of markets) {
      sessions.set(market, {
        market,
        localDate: '2026-07-10', // audited Friday; fixture windows use real instants below
        timeZone: market === 'KRX' ? 'Asia/Seoul' : 'America/New_York',
        openTime: new Date(now.getTime() - 86_400_000),
        closeTime: closeAt,
        earlyClose: false,
      });
    }
  },
  reset() {
    sessions.clear();
  },
};

const resolveState: typeof calendar.resolveStockMarketSessionState = (
  asset,
  now,
  ...args
) => {
  const market = calendar.resolveCalendarMarket(asset);
  const session = market && sessions.get(market);
  if (!session)
    return calendar.resolveStockMarketSessionState(asset, now, ...args);
  if (!isMarketSessionOverrideStoreReady()) {
    return {
      state: 'calendar_unavailable',
      market,
      currentSession: null,
      latestCompletedSession: null,
    };
  }
  return {
    state:
      now >= session.openTime && now < session.closeTime ? 'open' : 'closed',
    market,
    currentSession: session,
    latestCompletedSession: now >= session.closeTime ? session : null,
  };
};

const resolveEvent: typeof calendar.resolveRegularSessionForEvent = (
  asset,
  now,
  ...args
) => {
  const market = calendar.resolveCalendarMarket(asset);
  if (!market || !sessions.has(market))
    return calendar.resolveRegularSessionForEvent(asset, now, ...args);
  const state = resolveState(asset, now);
  return state?.state === 'open' ? state.currentSession : null;
};

// tsx exposes read-only CommonJS getters. Replace the cached exports before
// services load, retaining all other real calendar functions. This fixture is
// imported only by subprocess test runners, never by production services.
const cached =
  require.cache[require.resolve('../../src/orders/market-calendar.policy')];
if (!cached)
  throw new Error('Calendar module must be loaded before installing fixture');
cached.exports = {
  ...calendar,
  resolveStockMarketSessionState: resolveState,
  resolveRegularSessionForEvent: resolveEvent,
};
