// Pure x-axis layout math for the candlestick chart. No React Native imports so
// it can be unit-tested under `node --test`.

/**
 * On a wide chart we aim to make a "few candles" cluster look like a normal
 * trading chart rather than a handful of bars stretched edge-to-edge. The target
 * governs the capped slot width via `innerWidth / TARGET_VISIBLE_CANDLES`, so the
 * cap scales with the screen (phones fall back to MIN_SLOT_WIDTH, wide/web to the
 * target-derived width, never past MAX_SLOT_WIDTH).
 */
export const TARGET_VISIBLE_CANDLES = 60;
export const MIN_SLOT_WIDTH = 8;
export const MAX_SLOT_WIDTH = 22;
export const MIN_BODY_WIDTH = 2;
export const MAX_BODY_WIDTH = 16;
const BODY_RATIO = 0.62;

export type CandleXLayout = {
  /** Horizontal space allotted to one candle (body + gap). */
  slotWidth: number;
  /** Candle body width, clamped so it never exceeds its slot. */
  bodyWidth: number;
  /** Total width occupied by all candles (<= innerWidth). */
  plotWidth: number;
  /** X of the first candle's slot start; > paddingLeft when right-aligned. */
  xStart: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Decides candle spacing and where the candle series starts on the x-axis.
 *
 * - Enough candles → spread across the full chart width (slot = innerWidth/count),
 *   xStart = paddingLeft (unchanged behavior).
 * - Few candles → cap the slot at a target width and RIGHT-ALIGN the series, so
 *   the newest candle sits on the right and older candles stack to the left,
 *   leaving the left side empty instead of over-spreading a handful of candles.
 */
export function computeCandleXLayout(
  count: number,
  innerWidth: number,
  paddingLeft: number,
): CandleXLayout {
  const safeCount = Math.max(Math.floor(count), 1);
  const fullSlot = innerWidth / safeCount;
  const targetSlot = clamp(
    innerWidth / TARGET_VISIBLE_CANDLES,
    MIN_SLOT_WIDTH,
    MAX_SLOT_WIDTH,
  );
  // Whichever is smaller: full-width spacing (dense data) or the capped target
  // spacing (sparse data). This transitions smoothly as count grows.
  const slotWidth = Math.min(fullSlot, targetSlot);
  const plotWidth = slotWidth * safeCount;
  const xStart = paddingLeft + Math.max(0, innerWidth - plotWidth);
  const bodyWidth = clamp(
    slotWidth * BODY_RATIO,
    MIN_BODY_WIDTH,
    Math.min(MAX_BODY_WIDTH, slotWidth),
  );
  return { slotWidth, bodyWidth, plotWidth, xStart };
}

/** Center x of the candle at `index`. */
export function candleXCenter(
  xStart: number,
  slotWidth: number,
  index: number,
): number {
  return xStart + (index + 0.5) * slotWidth;
}

/**
 * Nearest candle index for a pointer x. Pointer positions in the empty left
 * region (x < xStart) snap to the first candle; positions past the last candle
 * snap to the last.
 */
export function candleIndexForX(
  xStart: number,
  slotWidth: number,
  x: number,
  count: number,
): number {
  if (slotWidth <= 0 || count <= 0) return 0;
  const raw = Math.round((x - xStart) / slotWidth - 0.5);
  return Math.min(Math.max(raw, 0), count - 1);
}
