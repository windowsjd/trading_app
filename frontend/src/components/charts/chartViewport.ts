// Pure viewport math for the candlestick chart: which candle indices are on
// screen, how pan/zoom gestures move that window, and how pixels map to
// candle slots. No React/RN imports so `node --test` covers every rule the
// gestures rely on.
//
// The viewport is a fractional window over the loaded candle array:
//   offset — index of the first visible slot (may be NEGATIVE when fewer
//            candles than slots exist: the series right-aligns and the left
//            side stays blank, keeping candle density identical),
//   size   — number of visible slots.
// Panning/zooming never leaves the loaded data range — there is no past
// loading here; the API's returned window is the world.

export type ChartViewport = {
  offset: number;
  size: number;
};

/** Default window: the latest 60 candles at identical density everywhere. */
export const DEFAULT_VISIBLE_CANDLES = 60;
export const MIN_VISIBLE_CANDLES = 12;
export const MAX_VISIBLE_CANDLES = 240;
/** Extra candles rendered on each side so panning never shows a blank edge. */
export const VIEWPORT_RENDER_BUFFER = 4;
/** Horizontal intent threshold: below this the parent ScrollView keeps the touch. */
export const HORIZONTAL_PAN_SLOP_PX = 8;
/** Hold this long without moving to enter crosshair mode on touch screens. */
export const LONG_PRESS_MS = 300;

const MIN_BODY_WIDTH = 1;
const MAX_BODY_WIDTH = 16;
const BODY_RATIO = 0.62;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Largest allowed window for `total` candles (never below the default 60). */
export function maxViewportSize(total: number): number {
  return clamp(total, DEFAULT_VISIBLE_CANDLES, MAX_VISIBLE_CANDLES);
}

export function clampViewportSize(size: number, total: number): number {
  const max = maxViewportSize(total);
  const min = Math.min(MIN_VISIBLE_CANDLES, max);
  if (!Number.isFinite(size)) return DEFAULT_VISIBLE_CANDLES;
  return clamp(size, min, max);
}

/**
 * Keeps the window on the data: with more data than slots the window stays
 * inside [0, total-size]; with less data there is exactly one legal position —
 * right-aligned (negative offset, blank left region).
 */
export function clampViewportOffset(
  offset: number,
  size: number,
  total: number,
): number {
  if (total <= size) return total - size;
  if (!Number.isFinite(offset)) return total - size;
  return clamp(offset, 0, total - size);
}

/** Latest data pinned to the right edge, 60-slot density. */
export function createInitialViewport(total: number): ChartViewport {
  const size = clampViewportSize(DEFAULT_VISIBLE_CANDLES, total);
  return { offset: total - size, size };
}

/** True when the window touches the newest candle (within half a slot). */
export function isAtLatestEdge(viewport: ChartViewport, total: number): boolean {
  return viewport.offset + viewport.size >= total - 0.5;
}

/**
 * Applies a data-length change to an existing viewport:
 *  - first data after an empty chart → fresh default window,
 *  - user parked at the right edge → stay pinned to the newest candle
 *    (live appends keep scrolling in),
 *  - user panned back in history → keep the position, just re-clamp.
 */
export function adjustViewportForDataChange(
  viewport: ChartViewport,
  previousTotal: number,
  nextTotal: number,
): ChartViewport {
  if (nextTotal <= 0 || previousTotal <= 0) {
    return createInitialViewport(Math.max(nextTotal, 0));
  }
  const size = clampViewportSize(viewport.size, nextTotal);
  if (isAtLatestEdge(viewport, previousTotal)) {
    return { offset: nextTotal - size, size };
  }
  return {
    offset: clampViewportOffset(viewport.offset, size, nextTotal),
    size,
  };
}

/**
 * Horizontal pan. `deltaPx > 0` = finger/mouse dragged RIGHT = content follows
 * the finger = older candles come into view (offset decreases).
 */
export function panViewportByPixels(
  viewport: ChartViewport,
  deltaPx: number,
  innerWidth: number,
  total: number,
): ChartViewport {
  if (innerWidth <= 0) return viewport;
  const slotWidth = innerWidth / viewport.size;
  const offset = clampViewportOffset(
    viewport.offset - deltaPx / slotWidth,
    viewport.size,
    total,
  );
  return offset === viewport.offset ? viewport : { ...viewport, offset };
}

/**
 * Zoom about an anchor expressed as a 0..1 ratio across the chart width.
 * `scale > 1` zooms IN (fewer visible candles). The candle under the anchor
 * stays under the anchor, so pinch/wheel zooming feels rooted at the fingers.
 */
export function zoomViewportAtRatio(
  viewport: ChartViewport,
  scale: number,
  anchorRatio: number,
  total: number,
): ChartViewport {
  if (!Number.isFinite(scale) || scale <= 0) return viewport;
  const ratio = clamp(anchorRatio, 0, 1);
  const size = clampViewportSize(viewport.size / scale, total);
  if (size === viewport.size) return viewport;
  const anchorIndex = viewport.offset + ratio * viewport.size;
  const offset = clampViewportOffset(anchorIndex - ratio * size, size, total);
  return { offset, size };
}

export function zoomViewportAtPixel(
  viewport: ChartViewport,
  scale: number,
  pixelX: number,
  innerWidth: number,
  total: number,
): ChartViewport {
  const ratio = innerWidth > 0 ? pixelX / innerWidth : 0.5;
  return zoomViewportAtRatio(viewport, scale, ratio, total);
}

export type ViewportIndexRange = {
  /** First candle index to use (inclusive). */
  start: number;
  /** One past the last candle index (exclusive). */
  endExclusive: number;
};

/** Candles that must be RENDERED: visible window plus a small pan buffer. */
export function visibleIndexRange(
  viewport: ChartViewport,
  total: number,
  buffer = VIEWPORT_RENDER_BUFFER,
): ViewportIndexRange {
  const start = clamp(Math.floor(viewport.offset) - buffer, 0, Math.max(total, 0));
  const endExclusive = clamp(
    Math.ceil(viewport.offset + viewport.size) + buffer,
    start,
    Math.max(total, 0),
  );
  return { start, endExclusive };
}

/** Candles that are actually ON SCREEN — the y-axis is computed from these. */
export function strictVisibleIndexRange(
  viewport: ChartViewport,
  total: number,
): ViewportIndexRange {
  return visibleIndexRange(viewport, total, 0);
}

export type ViewportSlotLayout = {
  slotWidth: number;
  bodyWidth: number;
};

/** Slot/body pixel widths for the current zoom level. */
export function viewportSlotLayout(
  innerWidth: number,
  size: number,
): ViewportSlotLayout {
  const slotWidth = size > 0 ? innerWidth / size : innerWidth;
  const bodyWidth = clamp(
    slotWidth * BODY_RATIO,
    Math.min(MIN_BODY_WIDTH, slotWidth),
    Math.min(MAX_BODY_WIDTH, slotWidth),
  );
  return { slotWidth, bodyWidth: Math.max(bodyWidth, 0.5) };
}

/** Center x (in SVG coordinates) of the candle at `index`. */
export function xCenterForIndex(
  index: number,
  viewport: ChartViewport,
  innerWidth: number,
  paddingLeft: number,
): number {
  const { slotWidth } = viewportSlotLayout(innerWidth, viewport.size);
  return paddingLeft + (index - viewport.offset + 0.5) * slotWidth;
}

/**
 * Candle index under a pointer x (SVG coordinates), snapped into the strictly
 * visible data range. Null when no candle is on screen at all.
 */
export function indexForPixel(
  pixelX: number,
  viewport: ChartViewport,
  innerWidth: number,
  paddingLeft: number,
  total: number,
): number | null {
  const { start, endExclusive } = strictVisibleIndexRange(viewport, total);
  if (endExclusive <= start) return null;
  const { slotWidth } = viewportSlotLayout(innerWidth, viewport.size);
  if (slotWidth <= 0) return start;
  const raw = Math.round(
    (pixelX - paddingLeft) / slotWidth + viewport.offset - 0.5,
  );
  return clamp(raw, start, endExclusive - 1);
}

/** Wheel/trackpad delta → zoom factor (scroll up / pinch out = zoom in). */
export function wheelZoomScale(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  return clamp(Math.exp(-deltaY * 0.002), 0.4, 2.5);
}

/** Two-finger distance → zoom factor relative to the pinch start. */
export function pinchScale(
  currentDistance: number,
  startDistance: number,
): number {
  if (startDistance <= 0 || !Number.isFinite(currentDistance)) return 1;
  return clamp(currentDistance / startDistance, 0.2, 5);
}

export function touchDistance(
  a: { pageX: number; pageY: number },
  b: { pageX: number; pageY: number },
): number {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

/**
 * Single-finger movement classification: the chart claims the gesture only for
 * clearly horizontal drags; vertical drags stay with the parent ScrollView.
 */
export function isHorizontalPanIntent(
  dx: number,
  dy: number,
  slopPx = HORIZONTAL_PAN_SLOP_PX,
): boolean {
  return Math.abs(dx) > slopPx && Math.abs(dx) > Math.abs(dy) * 1.2;
}
