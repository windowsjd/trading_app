/**
 * Pure time-boundary rules for path-B (closed 5-minute candle) matching.
 * No provider, DB, or session state here — just the deterministic 5-minute
 * boundary arithmetic the candle-evidence service builds its eligibility on.
 */

export const FIVE_MINUTES_MS = 5 * 60_000;

/** Floors a UTC instant down to its 5-minute boundary. */
export function floorTo5mMs(ms: number): number {
  return Math.floor(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

/**
 * The first closed 5-minute candle window an order may be filled from.
 *
 * A candle's window is [openTime, openTime+5m). A low printed inside a candle
 * that was ALREADY RUNNING when the order was submitted could have occurred
 * before submission, and candle data alone cannot tell before from after — so
 * that first partial window is never usable. Only candles whose window opens
 * at or after this boundary are eligible.
 *
 *   submitted 12:00:00.000 (exactly on a boundary) → 12:00  (the 12:00 candle
 *                                                            opens with/after
 *                                                            submission)
 *   submitted 12:00:00.500                          → 12:05  (12:00 candle was
 *                                                            already running)
 *   submitted 12:02:00                              → 12:05
 */
export function firstEligibleCandleOpenMs(submittedAtMs: number): number {
  const floored = floorTo5mMs(submittedAtMs);
  return submittedAtMs === floored ? floored : floored + FIVE_MINUTES_MS;
}

/** Date-typed convenience wrapper around {@link firstEligibleCandleOpenMs}. */
export function firstEligibleCandleOpen(submittedAt: Date): Date {
  return new Date(firstEligibleCandleOpenMs(submittedAt.getTime()));
}

/**
 * LOOKBACK bound: a closed candle is only usable while its window start is
 * within `lookbackMs` of now. Beyond that the touch is treated as unrecoverable
 * (no outage backfill), never retroactively filled.
 */
export function isCandleWithinLookback(
  candleOpenTime: Date,
  now: Date,
  lookbackMs: number,
): boolean {
  return candleOpenTime.getTime() >= now.getTime() - lookbackMs;
}
