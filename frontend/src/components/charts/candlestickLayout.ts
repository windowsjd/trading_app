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
 * Center x of a candle, given its SLOT offset from the left edge of the plot.
 * (`leadingEmptySlots + index - startIndex`, so callers keep using original
 * array indices.)
 */
export function candleXCenter(
  paddingLeft: number,
  slotWidth: number,
  offsetFromStart: number,
): number {
  return paddingLeft + (offsetFromStart + 0.5) * slotWidth;
}

/**
 * Empty slots on the LEFT when fewer candles are loaded than the viewport has
 * slots. Keeping the shortfall on the left is what right-aligns a 12-candle
 * chart while its candles stay exactly as wide as a 600-candle one.
 */
export function computeLeadingEmptySlots(
  viewportVisibleCount: number,
  actualVisibleCount: number,
): number {
  const slots =
    Number.isFinite(viewportVisibleCount) && viewportVisibleCount > 0
      ? Math.floor(viewportVisibleCount)
      : 0;
  const actual =
    Number.isFinite(actualVisibleCount) && actualVisibleCount > 0
      ? Math.floor(actualVisibleCount)
      : 0;
  return Math.max(0, slots - actual);
}

/**
 * Slot under a pointer x, clamped to the viewport's slot count. Slots include
 * the empty leading ones, so this is NOT a candle index — see
 * `originalCandleIndexForX`.
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

/**
 * Pointer x → ORIGINAL candle index, the one the crosshair labels describe.
 *
 * Empty leading slots hold no candle, so a pointer over them snaps to the first
 * real one; a pointer past the right edge snaps to the last. The result is
 * always inside [startIndex, endIndex - 1], so a crosshair can never address a
 * candle that does not exist.
 */
export function originalCandleIndexForX(input: {
  x: number;
  paddingLeft: number;
  slotWidth: number;
  /** Viewport slot count (empty slots included). */
  viewportVisibleCount: number;
  startIndex: number;
  endIndex: number;
  leadingEmptySlots: number;
}): number {
  const { startIndex, endIndex } = input;
  if (endIndex <= startIndex) return startIndex;
  const slot = visibleOffsetForX(
    input.x,
    input.paddingLeft,
    input.slotWidth,
    input.viewportVisibleCount,
  );
  const leading = Math.max(0, Math.floor(input.leadingEmptySlots));
  return clamp(startIndex + (slot - leading), startIndex, endIndex - 1);
}
