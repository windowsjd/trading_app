/**
 * Home's rolling community card (prompt ③): pure timing and pause rules, so
 * `node --test` covers them without React.
 */
export const TICKER_INTERVAL_MS = 4000;
export const TICKER_TRANSITION_MS = 450;
/** The outgoing post rises this far while fading; the next one rises from below. */
export const TICKER_SHIFT = 10;

export type TickerConditions = {
  count: number;
  /** Home is the focused screen. */
  focused: boolean;
  /** The app is in the foreground. */
  appActive: boolean;
  /** The card is being pressed. */
  pressed: boolean;
  reducedMotion: boolean;
};

/** Whether the card advances by itself now. One post, Reduce Motion, or any pause holds it. */
export function tickerShouldRotate(conditions: TickerConditions): boolean {
  return conditions.count > 1 && conditions.focused && conditions.appActive && !conditions.pressed && !conditions.reducedMotion;
}

export function nextTickerIndex(index: number, count: number): number {
  return count > 0 ? (clampTickerIndex(index, count) + 1) % count : 0;
}

/** A shorter list (a post left the HOT list) keeps a valid index. */
export function clampTickerIndex(index: number, count: number): number {
  return count > 0 && Number.isInteger(index) && index >= 0 && index < count ? index : 0;
}

/** Reduce Motion shows the first post and never moves. */
export function tickerDisplayIndex(index: number, count: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : clampTickerIndex(index, count);
}
