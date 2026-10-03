/** Press feedback is a static wash: no scale, ripple, release tail or timers. */
/** RN processColor ARGB value; choose a wash contrasting with its surface. */
export function getFeedbackPalette(color: number | null) {
  const alpha = color === null ? 0 : ((color >>> 24) & 255) / 255;
  const channel = (shift: number) => color === null ? 255 : ((color >>> shift) & 255) * alpha + 255 * (1 - alpha);
  const brightness = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  const nearWhite = brightness >= 235;
  return {
    washColor: nearWhite ? '#000' : '#fff',
    washOpacity: nearWhite ? 0.065 : 0.055,
  };
}
