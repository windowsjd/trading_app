import type { ColorValue, ImageStyle, StyleProp, TextStyle, ViewStyle } from 'react-native';
import type { AppearanceMode, AppearancePalette } from './appearance';
import { resolveFinancialColor, type FinancialColorPreference } from './financialColors.ts';

/** Brand actions are independent of selection and financial colors, in both modes. */
export const primaryGradient = {
  colors: ['#326FE5', '#7447D8'],
  foreground: '#FFFFFF',
  start: { x: '0%', y: '50%' },
  end: { x: '100%', y: '50%' },
  locations: ['0%', '100%'],
  opacity: 1,
} as const;

/** Explicit roles use valid color sentinels for native/web StyleSheet validation.
 * Only these tokens resolve through the appearance palette; arbitrary hex stays as written. */
export const semantic = {
  screen: '#0f0001',
  surface: '#0f0002',
  raised: '#0f0003',
  text: '#0f0004',
  secondary: '#0f0005',
  muted: '#0f0006',
  border: '#0f0007',
  input: '#0f0008',
  selected: '#0f0009',
  placeholder: '#0f000a',
  cursor: '#0f000b',
  navigation: '#0f000c',
  navigationActive: '#0f000d',
  navigationInactive: '#0f000e',
  pressed: '#0f000f',
  successSurface: '#0f0012',
  errorSurface: '#0f0013',
  success: '#0f0014',
  error: '#0f0015',
  warning: '#0f0016',
  warningSurface: '#0f0017',
  info: '#0f0018',
  infoSurface: '#0f0019',
  onAccent: '#0f001a',
  infoAction: '#0f001b',
  secondaryActionSurface: '#0f001c',
  secondaryActionForeground: '#0f001d',
} as const;

type Role = keyof typeof semantic;
const roleByValue = Object.fromEntries(Object.entries(semantic).map(([role, value]) => [value, role])) as Record<string, Role>;
export function resolveSemanticColor(value: ColorValue | undefined, colors: AppearancePalette, mode: AppearanceMode, financialPreference: FinancialColorPreference = 'red_blue') {
  const role = typeof value === 'string' ? roleByValue[value] : undefined;
  return role ? colors[role] : typeof value === 'string' ? resolveFinancialColor(value, mode, financialPreference) : value;
}

export function resolveSemanticStyle<T extends ViewStyle | TextStyle | ImageStyle>(style: StyleProp<T>, colors: AppearancePalette, mode: AppearanceMode, financialPreference: FinancialColorPreference = 'red_blue'): StyleProp<T> {
  if (!style) return style;
  const flatten = (entry: unknown): Record<string, unknown> => Array.isArray(entry)
    ? Object.assign({}, ...entry.map(flatten))
    : entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
  const flat = flatten(style);
  const overrides: Record<string, string> = {};
  for (const [property, value] of Object.entries(flat)) {
    if (typeof value !== 'string') continue;
    const resolved = resolveSemanticColor(value, colors, mode, financialPreference);
    if (resolved !== value && typeof resolved === 'string') overrides[property] = resolved;
  }
  return Object.keys(overrides).length ? [style, overrides as unknown as T] : style;
}
