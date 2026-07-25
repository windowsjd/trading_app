// Pure PIXEL geometry for the candlestick chart: how wide a candle slot is at
// the current zoom level and how screen x maps to a visible candle. The index
// window itself is owned by candlestickViewport.ts; this module only turns that
// window into coordinates. No React Native imports (node --test covers it).

export const MIN_BODY_WIDTH = 1;
export const MAX_BODY_WIDTH = 16;
const BODY_RATIO = 0.62;

export type CandleSlotLayout = {
  /** Horizontal space for one candle (body + gap). */
  slotWidth: number;
  /** Candle body width, never wider than its slot. */
  bodyWidth: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Slot/body widths for `visibleCount` candles across `innerWidth` pixels.
 * Zooming changes visibleCount, so the candles get wider/narrower — the axis
 * text is never scaled.
 */
export function computeSlotLayout(
  innerWidth: number,
  visibleCount: number,
): CandleSlotLayout {
  const width = Number.isFinite(innerWidth) && innerWidth > 0 ? innerWidth : 1;
  const count =
    Number.isFinite(visibleCount) && visibleCount > 0
      ? Math.floor(visibleCount)
      : 1;
  const slotWidth = width / count;
  const bodyWidth = clamp(
    slotWidth * BODY_RATIO,
    Math.min(MIN_BODY_WIDTH, slotWidth),
    Math.min(MAX_BODY_WIDTH, slotWidth),
  );
  return { slotWidth, bodyWidth: Math.max(bodyWidth, 0.5) };
}

/**
 * Center x of a candle, given its offset from the first VISIBLE candle.
 * (`index - startIndex`, so callers keep using original array indices.)
 */
export function candleXCenter(
  paddingLeft: number,
  slotWidth: number,
  offsetFromStart: number,
): number {
  return paddingLeft + (offsetFromStart + 0.5) * slotWidth;
}

/**
 * Visible-window offset under a pointer x, clamped to the window. Combine with
 * the viewport's `startIndex` to get the original candle index.
 */
export function visibleOffsetForX(
  x: number,
  paddingLeft: number,
  slotWidth: number,
  visibleCount: number,
): number {
  if (!Number.isFinite(x) || slotWidth <= 0 || visibleCount <= 0) return 0;
  const raw = Math.round((x - paddingLeft) / slotWidth - 0.5);
  return clamp(raw, 0, visibleCount - 1);
}
