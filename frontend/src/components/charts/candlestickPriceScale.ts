/** Display geometry only. Monetary/quote values never use this math. */
export type PriceRange = { minY: number; maxY: number; range: number };
export type ManualPriceScale = {
  center: number;
  halfRange: number;
  factor: number;
};
export const MIN_PRICE_SCALE = 0.1;
export const MAX_PRICE_SCALE = 10;
const MIN_PRICE = 1e-12;
const MAX_PRICE = 1e20;

export function priceRange(min: number, max: number): PriceRange {
  const low = Number.isFinite(min) && min > 0 ? Math.min(min, MAX_PRICE) : 1;
  const high = Number.isFinite(max) && max > 0 ? Math.min(max, MAX_PRICE) : low;
  const bottom = Math.min(low, high),
    top = Math.max(low, high);
  const pad = Math.max((top - bottom) * 0.08, top * 0.01, MIN_PRICE);
  const minY = Math.max(MIN_PRICE, bottom * 0.001, bottom - pad);
  const maxY = Math.max(minY * 1.01, top + pad);
  return { minY, maxY, range: maxY - minY };
}

export function capturePriceScale(range: PriceRange): ManualPriceScale {
  return {
    center: range.minY + range.range / 2,
    halfRange: range.range / 2,
    factor: 1,
  };
}

export function scalePriceByPixels(
  start: ManualPriceScale,
  deltaY: number,
): ManualPriceScale {
  if (!Number.isFinite(deltaY)) return start;
  // Drag down expands the range (compresses candles); drag up narrows it.
  const factor = Math.min(
    MAX_PRICE_SCALE,
    Math.max(
      MIN_PRICE_SCALE,
      start.factor * Math.exp(Math.max(-10, Math.min(10, deltaY * 0.006))),
    ),
  );
  return { ...start, factor };
}

/**
 * A vertical pinch: `scale` > 1 (fingers apart) narrows the range so the same
 * move looks larger, < 1 widens it, within the same factor limits as a drag.
 * The price under `anchor` (0 plot top … 1 bottom: where the pinch began)
 * stays there, except that a wide range never goes below zero.
 */
export function zoomPriceScale(
  start: ManualPriceScale,
  scale: number,
  anchor: number,
): ManualPriceScale {
  if (!Number.isFinite(scale) || scale <= 0) return start;
  const factor = Math.min(
    MAX_PRICE_SCALE,
    Math.max(MIN_PRICE_SCALE, start.factor / scale),
  );
  const at = Number.isFinite(anchor) ? Math.min(1, Math.max(0, anchor)) : 0.5;
  const before = scaledPriceRange(start);
  const { range } = scaledPriceRange({ ...start, factor });
  const price = before.maxY - at * before.range;
  const minY = Math.max(MIN_PRICE, price - (1 - at) * range);
  return { ...start, center: minY + range / 2, factor };
}

export function scaledPriceRange(scale: ManualPriceScale): PriceRange {
  const center =
    Number.isFinite(scale.center) && scale.center > MIN_PRICE * 2
      ? Math.min(scale.center, MAX_PRICE)
      : 1;
  const factor = Number.isFinite(scale.factor)
    ? Math.max(MIN_PRICE_SCALE, Math.min(MAX_PRICE_SCALE, scale.factor))
    : 1;
  const baseHalf =
    Number.isFinite(scale.halfRange) && scale.halfRange > 0
      ? scale.halfRange
      : center * 0.01;
  // Keep a positive, finite, symmetric range even for tiny coins/flat candles.
  const half = Math.min(
    center * (1 - 1e-12),
    Math.max(center * 1e-8, MIN_PRICE, baseHalf * factor),
  );
  return { minY: center - half, maxY: center + half, range: half * 2 };
}

/**
 * Vertical chart move (2026-11-13): the candles and every price on the plot
 * follow the finger — dragging down by `deltaY` px shows higher prices at the
 * same height, at the window's current size. The window never goes below
 * zero, and it always keeps some of `bounds` (the loaded candles' prices) in
 * view, so the chart cannot be dragged into an empty space it cannot leave.
 */
export function panPriceScale(
  start: ManualPriceScale,
  deltaY: number,
  plotHeight: number,
  bounds?: { min: number; max: number } | null,
): ManualPriceScale {
  if (!Number.isFinite(deltaY) || !Number.isFinite(plotHeight) || plotHeight <= 0) return start;
  const { minY, range } = scaledPriceRange(start);
  const half = range / 2;
  let center = minY + half + (deltaY / plotHeight) * range;
  if (bounds && Number.isFinite(bounds.min) && Number.isFinite(bounds.max) && bounds.max >= bounds.min) {
    // At least a fifth of the window stays over the loaded prices.
    center = Math.min(Math.max(center, bounds.min - half * 0.8), bounds.max + half * 0.8);
  }
  // Above zero with the same size: the window's bottom stays positive.
  center = Math.min(Math.max(center, half * (1 + 1e-9) + MIN_PRICE), MAX_PRICE);
  // Keep the size exactly: express the moved window in the start's own terms.
  return { ...start, center, halfRange: half / clampedFactor(start.factor) };
}

function clampedFactor(factor: number) {
  return Number.isFinite(factor) ? Math.max(MIN_PRICE_SCALE, Math.min(MAX_PRICE_SCALE, factor)) : 1;
}
