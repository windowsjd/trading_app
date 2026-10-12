import type { ViewStyle } from 'react-native';

/** One clock drives the button surface scale; the ink ripple has its own. */
export const buttonFeedback = { scale: 0.97, pressDuration: 90, releaseDuration: 150 } as const;

/**
 * Ink ripple (reference video 1): a hard-edged circle grows from the touch
 * point and covers the surface in about 130ms (ease-out), holds while pressed
 * and fades out in about 130ms on release.
 */
export const rippleMotion = { spreadDuration: 240, fadeDuration: 130, startScale: 0.01 } as const;

/** `subtle` is for commands that execute a trade: feedback, never emphasis. */
export type RippleTone = 'default' | 'subtle';

// Placement/sizing belongs to the stationary hit target. Paint, padding and
// child layout belong to the visual surface, which still sizes its parent.
const targetKeys = new Set([
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'aspectRatio',
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'position',
  'top', 'bottom', 'left', 'right', 'start', 'end', 'inset', 'insetBlock',
  'insetBlockStart', 'insetBlockEnd', 'insetInline', 'insetInlineStart', 'insetInlineEnd',
  'zIndex', 'display', 'direction', 'opacity', 'transform', 'transformOrigin',
]);
export function splitButtonStyle(style: ViewStyle) {
  const target: Record<string, unknown> = {};
  const surface: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    (targetKeys.has(key) || key.startsWith('margin') ? target : surface)[key] = value;
  }
  // An unpainted radius keeps the keyboard focus outline aligned to the button.
  if (style.borderRadius !== undefined) target.borderRadius = style.borderRadius;
  return { target: target as ViewStyle, surface: surface as ViewStyle };
}

function channels(color: number | null) {
  const alpha = color === null ? 0 : ((color >>> 24) & 255) / 255;
  const channel = (shift: number) => color === null ? 255 : ((color >>> shift) & 255) * alpha + 255 * (1 - alpha);
  return [channel(16), channel(8), channel(0)] as const;
}
const brightnessOf = ([r, g, b]: readonly [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Selection controls (and Reduced Motion) keep one immediate static tint.
 * RN processColor ARGB value; choose a wash contrasting with its surface.
 */
export function getFeedbackPalette(color: number | null) {
  const nearWhite = brightnessOf(channels(color)) >= 235;
  return {
    washColor: nearWhite ? '#000' : '#fff',
    washOpacity: nearWhite ? 0.065 : 0.055,
  };
}

/**
 * The ripple darkens its own surface, like the reference: a deeper tone of a
 * colored button, a soft shade on white. Only neutral near-black surfaces
 * (dark mode, the neutral CTA) are lifted with white instead.
 */
export function getRipplePalette(color: number | null, tone: RippleTone = 'default') {
  const rgb = channels(color);
  const brightness = brightnessOf(rgb);
  const max = Math.max(...rgb);
  const saturation = max === 0 ? 0 : (max - Math.min(...rgb)) / max;
  const lift = brightness < 80 && saturation < 0.5;
  const base = lift ? 0.16 : brightness >= 235 ? 0.07 : brightness >= 170 ? 0.1 : 0.16;
  return {
    rippleColor: lift ? '#fff' : '#000',
    rippleOpacity: Math.round(base * (tone === 'subtle' ? 0.6 : 1) * 1000) / 1000,
  };
}

export type RippleOrigin = { x: number; y: number };
export type RippleSize = { width: number; height: number };

/** A touch without coordinates (keyboard, accessibility) starts at the center. */
export function rippleOrigin(size: RippleSize, x?: number, y?: number): RippleOrigin {
  const inside = (value: number | undefined, limit: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), limit) : limit / 2;
  return { x: inside(x, size.width), y: inside(y, size.height) };
}

/** Radius that reaches the farthest corner from the origin. */
export function rippleRadius(size: RippleSize, origin: RippleOrigin) {
  return Math.hypot(Math.max(origin.x, size.width - origin.x), Math.max(origin.y, size.height - origin.y));
}

/**
 * The ink is one fixed circle scaled to the surface, so measuring a surface
 * never re-renders it (rows in long lists mount without an extra pass).
 */
export const RIPPLE_BASE = 64;
/** Scale at which the circle reaches the farthest corner from the origin. */
export const rippleScale = (size: RippleSize, origin: RippleOrigin) => (2 * rippleRadius(size, origin)) / RIPPLE_BASE;
