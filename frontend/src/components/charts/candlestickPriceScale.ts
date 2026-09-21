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
