export const RIPPLE_EXPAND_DURATION_MS = 330;
export const RIPPLE_FADE_DURATION_MS = 180;
export const PRESS_IN_SCALE = 0.99;
export const PRESS_IN_DURATION_MS = 90;
export const PRESS_OUT_DURATION_MS = 150;
export const WASH_FADE_DURATION_MS = 140;

/** Page coordinates avoid a nested Text/View becoming the ripple origin. */
export function getRippleGeometry(
  pageX: number | undefined,
  pageY: number | undefined,
  bounds: { pageX: number; pageY: number; width: number; height: number },
) {
  const { width, height } = bounds;
  const x = Number.isFinite(pageX) ? Math.max(0, Math.min(width, pageX - bounds.pageX)) : width / 2;
  const y = Number.isFinite(pageY) ? Math.max(0, Math.min(height, pageY - bounds.pageY)) : height / 2;
  return { x, y, radius: Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) };
}

/** RN processColor's ARGB value, composited over the app's light surface. */
export function getFeedbackPalette(color: number | null) {
  const alpha = color === null ? 0 : ((color >>> 24) & 255) / 255;
  const channel = (shift: number) => color === null ? 255 : ((color >>> shift) & 255) * alpha + 255 * (1 - alpha);
  const brightness = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  const nearWhite = brightness >= 235;
  return {
    rippleColor: nearWhite ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.16)',
    // A neutral white wash preserves hue. Near-white surfaces need only ripple.
    washOpacity: nearWhite ? 0 : 0.045,
  };
}
