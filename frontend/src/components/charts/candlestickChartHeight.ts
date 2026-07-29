// Responsive height for the candlestick chart. Pure (no React Native imports)
// so `node --test` covers the policy; the component only feeds it the window
// dimensions plus `Platform.OS`, and re-renders on resize/orientation change.
//
// The chart is the MAIN trading surface of the detail screen: a price axis, a
// time axis, a crosshair, pan and zoom do not fit in a 240px strip. It takes a
// share of the window instead, and everything below it is reached by the
// detail screen's existing vertical ScrollView — the chart is never shrunk to
// squeeze more content into one screenful.
//
// Layout class is NOT width alone. A landscape phone is 844 × 390: judged by
// width it would pass for a tablet and ask for a 500px chart inside a 390px
// window. Native devices are classified by their SHORT side, which does not
// change when the device rotates; only web keeps the width rule, where window
// width really is the layout (a 844px browser window IS a wide layout).

/** Web: at or above this window width the layout counts as wide. */
export const WIDE_LAYOUT_MIN_WIDTH = 768;
/** Native: short side at or above this is a tablet, in either orientation. */
export const NATIVE_TABLET_MIN_SHORT_SIDE = 600;

export const MOBILE_CHART_HEIGHT_RATIO = 0.52;
export const MOBILE_CHART_MIN_HEIGHT = 380;
export const MOBILE_CHART_MAX_HEIGHT = 480;

export const WIDE_CHART_HEIGHT_RATIO = 0.6;
export const WIDE_CHART_MIN_HEIGHT = 500;
export const WIDE_CHART_MAX_HEIGHT = 680;

/** Only 'web' switches to the width rule; anything else is a native device. */
export type ChartLayoutPlatform = 'ios' | 'android' | 'web' | 'unknown';

/** `phone` / `webNarrow` use the phone height policy, the other two the wide one. */
export type ChartLayoutClass = 'phone' | 'tablet' | 'webNarrow' | 'webWide';

export type ChartLayoutInput = {
  windowWidth: number;
  windowHeight: number;
  platform: ChartLayoutPlatform;
};

/** `Platform.OS` → the platforms this policy distinguishes. */
export function toChartLayoutPlatform(
  platformOS: string | null | undefined,
): ChartLayoutPlatform {
  if (platformOS === 'web') return 'web';
  if (platformOS === 'ios') return 'ios';
  if (platformOS === 'android') return 'android';
  // macOS/Windows/anything else: treated as a native device (short-side rule).
  return 'unknown';
}

function usableSide(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Layout class for the current window:
 *  - web: window width < 768 → `webNarrow`, otherwise `webWide`,
 *  - native: short side (`min(width, height)`) < 600 → `phone`, else `tablet`
 *    — so rotating a device never changes its class.
 *
 * Unusable dimensions fall back to the smaller class, never to a chart taller
 * than the window.
 */
export function getCandlestickChartLayoutClass({
  windowWidth,
  windowHeight,
  platform,
}: ChartLayoutInput): ChartLayoutClass {
  if (platform === 'web') {
    return Number.isFinite(windowWidth) && windowWidth >= WIDE_LAYOUT_MIN_WIDTH
      ? 'webWide'
      : 'webNarrow';
  }
  const shortSide = Math.min(usableSide(windowWidth), usableSide(windowHeight));
  if (!Number.isFinite(shortSide)) return 'phone';
  return shortSide >= NATIVE_TABLET_MIN_SHORT_SIDE ? 'tablet' : 'phone';
}

/**
 * Chart height in px:
 *  - phone / narrow web: ~52% of the window height, 380–480,
 *  - tablet / wide web: ~60% of the window height, 500–680.
 *
 * Non-finite or non-positive input falls back to the minimum of its layout
 * class, so a chart is never rendered at 0 height.
 */
export function getCandlestickChartHeight(input: ChartLayoutInput): number {
  const layoutClass = getCandlestickChartLayoutClass(input);
  const isWide = layoutClass === 'tablet' || layoutClass === 'webWide';
  const ratio = isWide ? WIDE_CHART_HEIGHT_RATIO : MOBILE_CHART_HEIGHT_RATIO;
  const minHeight = isWide ? WIDE_CHART_MIN_HEIGHT : MOBILE_CHART_MIN_HEIGHT;
  const maxHeight = isWide ? WIDE_CHART_MAX_HEIGHT : MOBILE_CHART_MAX_HEIGHT;

  const { windowHeight } = input;
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return minHeight;
  return Math.round(clamp(windowHeight * ratio, minHeight, maxHeight));
}
