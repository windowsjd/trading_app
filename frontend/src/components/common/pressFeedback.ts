import type { ViewStyle } from 'react-native';

/** One clock drives the button surface and its single neutral overlay. */
export const buttonFeedback = { scale: 0.97, pressDuration: 90, releaseDuration: 150, washColor: '#000', washOpacity: 0.10 } as const;

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

/** Rows/disclosures retain their immediate static feedback. */
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
