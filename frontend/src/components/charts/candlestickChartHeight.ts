// Responsive height for the candlestick chart. Pure (no React Native imports)
// so `node --test` covers the policy; the component only feeds it the window
// dimensions and re-renders on resize/orientation change.
//
// The chart is the MAIN trading surface of the detail screen: a price axis, a
// time axis, a crosshair, pan and zoom do not fit in a 240px strip. It takes a
// share of the window instead, and everything below it is reached by the
// detail screen's existing vertical ScrollView — the chart is never shrunk to
// squeeze more content into one screenful.

/** At or above this width the layout counts as tablet/desktop. */
export const WIDE_LAYOUT_MIN_WIDTH = 768;

export const MOBILE_CHART_HEIGHT_RATIO = 0.52;
export const MOBILE_CHART_MIN_HEIGHT = 380;
export const MOBILE_CHART_MAX_HEIGHT = 480;

export const WIDE_CHART_HEIGHT_RATIO = 0.6;
export const WIDE_CHART_MIN_HEIGHT = 500;
export const WIDE_CHART_MAX_HEIGHT = 680;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Chart height in px for a window of `windowWidth` × `windowHeight`:
 *  - narrow (phone): ~52% of the window height, 380–480,
 *  - wide (tablet/web): ~60% of the window height, 500–680.
 *
 * Non-finite or non-positive input falls back to the minimum of its layout
 * class, so a chart is never rendered at 0 height.
 */
export function getCandlestickChartHeight(
  windowWidth: number,
  windowHeight: number,
): number {
  const isWide =
    Number.isFinite(windowWidth) && windowWidth >= WIDE_LAYOUT_MIN_WIDTH;
  const ratio = isWide ? WIDE_CHART_HEIGHT_RATIO : MOBILE_CHART_HEIGHT_RATIO;
  const minHeight = isWide ? WIDE_CHART_MIN_HEIGHT : MOBILE_CHART_MIN_HEIGHT;
  const maxHeight = isWide ? WIDE_CHART_MAX_HEIGHT : MOBILE_CHART_MAX_HEIGHT;

  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return minHeight;
  return Math.round(clamp(windowHeight * ratio, minHeight, maxHeight));
}
