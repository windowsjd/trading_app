// Pure viewport math for the candlestick chart: which candles are on screen and
// how pan/zoom move that window. No React/React Native imports so `node --test`
// covers every rule the gestures depend on.
//
// The viewport is a window over the ALREADY LOADED candle array:
//   visibleCount — how many SLOTS fill the chart width,
//   rightOffset  — how many candles the window sits back from the newest one
//                  (0 = latest candle is the rightmost one on screen).
//
// `visibleCount` counts SCREEN SLOTS, not candles, and is deliberately
// independent of how much data exists: a 5m chart with 40 candles and a 1w
// chart with 600 both open at 60 slots, so a candle is the same width on every
// timeframe. When fewer candles than slots are loaded, the missing ones stay
// EMPTY on the LEFT and the newest candle keeps the right edge (see
// `computeLeadingEmptySlots` in candlestickLayout.ts).
//
// Panning/zooming never leaves the loaded range: this module knows nothing
// about fetching more history, which keeps that a future addition rather than
// a hidden dependency.

export const MIN_VISIBLE_CANDLES = 20;
export const DEFAULT_VISIBLE_CANDLES = 60;
export const MAX_VISIBLE_CANDLES = 180;
/** Extra candles rendered on each side so a pan never shows a blank edge. */
export const BUFFER_CANDLES = 2;

export type CandleViewport = {
  visibleCount: number;
  rightOffset: number;
};

export type VisibleIndexRange = {
  /** First visible candle index (inclusive). */
  startIndex: number;
  /** One past the last visible candle index (exclusive). */
  endIndex: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeTotal(totalCount: number): number {
  if (!Number.isFinite(totalCount) || totalCount <= 0) return 0;
  return Math.floor(totalCount);
}

/**
 * Slot-count bounds: the zoom-in floor and the zoom-out ceiling, NOT the amount
 * of data. A short data set keeps the default slot width and simply leaves the
 * left slots empty — only a completely empty data set collapses the viewport.
 */
export function clampVisibleCount(
  visibleCount: number,
  totalCount: number,
): number {
  const total = safeTotal(totalCount);
  if (total === 0) return 0;
  if (!Number.isFinite(visibleCount)) return DEFAULT_VISIBLE_CANDLES;
  return clamp(Math.round(visibleCount), MIN_VISIBLE_CANDLES, MAX_VISIBLE_CANDLES);
}

/** Keeps the window inside the data: 0 = latest, max = oldest. */
export function clampRightOffset(
  rightOffset: number,
  visibleCount: number,
  totalCount: number,
): number {
  const total = safeTotal(totalCount);
  const count = clampVisibleCount(visibleCount, total);
  const max = Math.max(0, total - count);
  if (!Number.isFinite(rightOffset)) return 0;
  return clamp(Math.round(rightOffset), 0, max);
}

/**
 * Latest data at the default density. The slot count is the SAME for every
 * timeframe (60) even when fewer candles are loaded — those charts render
 * right-aligned with empty leading slots instead of fat candles.
 */
export function createDefaultViewport(totalCount: number): CandleViewport {
  const visibleCount = clampVisibleCount(DEFAULT_VISIBLE_CANDLES, totalCount);
  return { visibleCount, rightOffset: 0 };
}

/** Timeframe switch / reset button: latest window, default density. */
export function resetViewport(totalCount: number): CandleViewport {
  return createDefaultViewport(totalCount);
}

export function isViewingLatest(viewport: CandleViewport): boolean {
  return viewport.rightOffset <= 0;
}

/** Normalizes any viewport against the current data length. */
export function clampViewport(
  viewport: CandleViewport,
  totalCount: number,
): CandleViewport {
  const visibleCount = clampVisibleCount(viewport.visibleCount, totalCount);
  return {
    visibleCount,
    rightOffset: clampRightOffset(viewport.rightOffset, visibleCount, totalCount),
  };
}

/**
 * REAL data indices on screen. With fewer candles than slots this returns the
 * whole data set (0 → totalCount); the leftover slots are empty space, never
 * fake indices.
 */
export function getVisibleIndexRange(
  totalCount: number,
  viewport: CandleViewport,
): VisibleIndexRange {
  const total = safeTotal(totalCount);
  if (total === 0) return { startIndex: 0, endIndex: 0 };
  const { visibleCount, rightOffset } = clampViewport(viewport, total);
  const endIndex = total - rightOffset;
  const startIndex = Math.max(0, endIndex - visibleCount);
  return { startIndex, endIndex };
}

/** Visible range plus the render buffer, clamped to the data. */
export function getRenderIndexRange(
  totalCount: number,
  viewport: CandleViewport,
  buffer: number = BUFFER_CANDLES,
): VisibleIndexRange {
  const total = safeTotal(totalCount);
  const { startIndex, endIndex } = getVisibleIndexRange(total, viewport);
  return {
    startIndex: Math.max(0, startIndex - buffer),
    endIndex: Math.min(total, endIndex + buffer),
  };
}

/**
 * Horizontal pan. `translationX > 0` = dragged RIGHT = content follows the
 * finger = older candles scroll in (rightOffset grows).
 */
export function panViewportByPixels(
  viewport: CandleViewport,
  translationX: number,
  slotWidth: number,
  totalCount: number,
): CandleViewport {
  const base = clampViewport(viewport, totalCount);
  if (!Number.isFinite(translationX) || !Number.isFinite(slotWidth)) return base;
  if (slotWidth <= 0) return base;
  // Rounded to whole candles: gestures pass the translation from their own
  // start against a snapshot viewport, so there is no accumulated drift.
  const movedCandles = Math.round(translationX / slotWidth);
  return {
    visibleCount: base.visibleCount,
    rightOffset: clampRightOffset(
      base.rightOffset + movedCandles,
      base.visibleCount,
      totalCount,
    ),
  };
}

/**
 * Zoom about the candle under `focalX`. `scale > 1` zooms IN (fewer candles).
 * The focal candle keeps its screen position, so pinching at the right edge
 * holds the newest candle and pinching in history does not jump to the latest.
 */
export function zoomViewportAtFocalPoint(
  viewport: CandleViewport,
  scale: number,
  focalX: number,
  innerWidth: number,
  totalCount: number,
): CandleViewport {
  const base = clampViewport(viewport, totalCount);
  const total = safeTotal(totalCount);
  if (total === 0) return base;
  if (!Number.isFinite(scale) || scale <= 0) return base;

  const nextVisibleCount = clampVisibleCount(base.visibleCount / scale, total);
  if (nextVisibleCount === base.visibleCount) return base;

  const ratio =
    Number.isFinite(focalX) && Number.isFinite(innerWidth) && innerWidth > 0
      ? clamp(focalX / innerWidth, 0, 1)
      : 0.5;

  const { startIndex, endIndex } = getVisibleIndexRange(total, base);
  // Fractional index under the focal point (measured from the window start).
  const focalIndex = startIndex + ratio * (endIndex - startIndex);
  const nextEndIndex = focalIndex + (1 - ratio) * nextVisibleCount;

  return {
    visibleCount: nextVisibleCount,
    rightOffset: clampRightOffset(
      total - nextEndIndex,
      nextVisibleCount,
      total,
    ),
  };
}

/**
 * Is this viewport the default window (latest data, default density)? The
 * chart uses it to show its "최신" reset affordance only when it would do
 * something.
 */
export function isDefaultViewport(
  viewport: CandleViewport,
  totalCount: number,
): boolean {
  const base = clampViewport(viewport, totalCount);
  const target = createDefaultViewport(totalCount);
  return (
    base.visibleCount === target.visibleCount &&
    base.rightOffset === target.rightOffset
  );
}

/**
 * Applies a data-length change (live candle appended, refetch, first load):
 *  - empty → default window,
 *  - viewing the latest → stay pinned to the newest candle,
 *  - viewing history → keep the SAME candles on screen by ageing rightOffset
 *    with the number of appended candles.
 */
export function adjustViewportForDataChange(
  viewport: CandleViewport,
  previousTotal: number,
  nextTotal: number,
): CandleViewport {
  const previous = safeTotal(previousTotal);
  const next = safeTotal(nextTotal);
  if (next === 0) return { visibleCount: 0, rightOffset: 0 };
  if (previous === 0) return createDefaultViewport(next);

  const base = clampViewport(viewport, previous);
  if (isViewingLatest(base)) {
    return clampViewport({ ...base, rightOffset: 0 }, next);
  }
  const appended = next - previous;
  return clampViewport(
    { ...base, rightOffset: base.rightOffset + Math.max(0, appended) },
    next,
  );
}
