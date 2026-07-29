import type { MarketSessionWindow } from '../orders/market-calendar.policy';

const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * KRX closing single-price auction (종가 단일가) length.
 *
 * The last 10 minutes of the KRX regular session still ACCEPT orders, but
 * they are matched in one auction at the close instead of by continuous
 * trading. There are therefore no continuous-trading prints in that window:
 * the KIS domestic minute feed returns 15:15–15:19 and then jumps straight to
 * a single 15:30 closing-auction row, so `KisDomesticFiveMinuteBuilder` never
 * produces a 15:20 or 15:25 five-minute candle — on any stock, on any day.
 *
 * This is a CANDLE-AGGREGATION concern only. The session itself is still open
 * (orders are accepted until 15:30), so the shared market-calendar policy must
 * keep reporting the full 09:00–15:30 window for order matching; only the
 * "which 5m candles should exist" question excludes the auction slots.
 *
 * Expressed relative to the session close so calendar close overrides move the
 * auction window with them (e.g. the 수능일 10:00–16:30 session excludes 16:20
 * and 16:25 instead of 15:20/15:25).
 */
const KRX_CLOSING_AUCTION_MS = 10 * 60_000;

/**
 * Exclusive upper bound of 5m `openTime`s that a regular session is expected
 * to produce a candle for.
 *
 * Slots at or after this bound are NOT forbidden — a stored candle there is
 * still aggregated into its bucket's OHLCV — they are merely never REQUIRED
 * for completeness.
 */
export function resolveRequiredFiveMinuteSlotEndMs(
  session: MarketSessionWindow,
): number {
  const closeMs = session.closeTime.getTime();
  if (session.market !== 'KRX') return closeMs;
  return Math.max(session.openTime.getTime(), closeMs - KRX_CLOSING_AUCTION_MS);
}

/**
 * How many 5m candles the half-open `[fromMs, toMs)` sub-range of a session is
 * expected to contain. `fromMs` must sit on the session's 5-minute grid.
 *
 * KRX regular day: the 13:00–15:30 four-hour bucket spans 30 grid slots but
 * expects 28 (13:00 … 15:15); 15:20 and 15:25 are auction slots.
 */
export function countRequiredFiveMinuteSlots(
  session: MarketSessionWindow,
  fromMs: number,
  toMs: number,
): number {
  const limit = Math.min(toMs, resolveRequiredFiveMinuteSlotEndMs(session));
  return limit <= fromMs ? 0 : Math.ceil((limit - fromMs) / FIVE_MINUTES_MS);
}
