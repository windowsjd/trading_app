import { serverMarket } from '../order/orderMethods.ts';

/**
 * How a NEW spot conditional BUY or SELL condition gets its 이상/이하
 * (2026-10-18). Pure module: runs under `node --test`.
 *
 * - `auto`: crypto Spot (never closes) and a stock whose regular session is
 *   open. The direction follows the watch price against the fresh current
 *   price (autoDirection); without one nothing is registered — a price
 *   failure during the session is not a closure.
 * - `manual`: a stock whose market the server reports closed (outside the
 *   regular session, a weekend or holiday) on a server that registers such
 *   watches (`offSessionMarkets`). The user chooses 이상/이하 — nothing is
 *   preselected — and the server watches from the next regular session, with
 *   that session's prices only.
 * - `blocked`: the market state is unknown (calendar unavailable, unknown
 *   status), or a closed market on an older server. Nothing is registered and
 *   the actual cause is shown; an unknown state is never taken for a closure.
 *
 * The server decides again at its own clock: during the session it refuses a
 * direction the price already meets, so a choice made while closed never
 * registers against an open market's price. Stop-loss/take-profit settings
 * and Futures conditional entries are not decided here.
 */
export type ConditionalDirectionMode =
  | { mode: 'auto' }
  | { mode: 'manual' }
  | { mode: 'blocked'; reason: string };

export const OFF_SESSION_REGISTRATION_NOTICE =
  '정규장 외 시간입니다. 감시 방향을 선택하면 조건주문을 등록할 수 있으며, 다음 정규장부터 감시합니다.';
export const LIVE_PRICE_UNAVAILABLE = '현재가를 확인할 수 없습니다. 시세가 업데이트된 후 다시 시도해주세요.';
export const MARKET_STATE_UNAVAILABLE =
  '시장 운영 상태를 확인할 수 없어 지금은 조건주문을 등록할 수 없어요. 잠시 후 다시 시도해 주세요.';
export const OFF_SESSION_UNSUPPORTED = '정규장 외 시간에는 조건주문을 등록할 수 없어요. 정규장 중에 다시 시도해 주세요.';
export const DIRECTION_REQUIRED = '감시 방향(이상 도달 또는 이하 도달)을 선택해 주세요.';

export function resolveConditionalDirectionMode(input: {
  assetType: string | null | undefined;
  /** The screen's market state (server status, overlaid by the ticker). */
  marketStatus: string | null | undefined;
  /** Server capability; absent on an older server. */
  offSessionMarkets: readonly string[] | null | undefined;
}): ConditionalDirectionMode {
  const market = serverMarket(input.assetType);
  if (market !== 'KRX' && market !== 'US') return { mode: 'auto' };
  if (input.marketStatus === 'open') return { mode: 'auto' };
  if (input.marketStatus === 'closed')
    return input.offSessionMarkets?.includes(market)
      ? { mode: 'manual' }
      : { mode: 'blocked', reason: OFF_SESSION_UNSUPPORTED };
  return { mode: 'blocked', reason: MARKET_STATE_UNAVAILABLE };
}

/**
 * The form's own words for a refused registration whose generic copy speaks
 * of orders or of the old in-session-only rule; null keeps the shared copy.
 */
export function getConditionalRegistrationErrorMessage(code: string | null | undefined): string | null {
  if (code === 'CONDITIONAL_PRICE_UNAVAILABLE') return LIVE_PRICE_UNAVAILABLE;
  if (code === 'MARKET_CALENDAR_UNAVAILABLE') return MARKET_STATE_UNAVAILABLE;
  return null;
}

/** Codes after which the screen's price and market state are read again. */
export function shouldRefreshAfterRegistrationError(code: string | null | undefined) {
  return code === 'CONDITIONAL_PRICE_UNAVAILABLE'
    || code === 'MARKET_CALENDAR_UNAVAILABLE'
    || code === 'CONDITIONAL_BUY_ALREADY_MET'
    || code === 'CONDITIONAL_SELL_ALREADY_MET';
}
