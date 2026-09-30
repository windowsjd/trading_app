import { StyleSheet, type ImageStyle, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { PALETTES, type AppearanceMode } from './appearance';

// Existing presentation colors are translated at the native primitive edge.
// Financial meaning colors (buy/sell, up/down) keep their meaning; only dark
// contrast and neutral surfaces change. Screens retain their layout styles.
const neutralBackgrounds = new Set([
  '#fff', '#ffffff', '#fafafa', '#f8f9fa', '#f5f7f8', '#f4f6f8',
  '#f2f5f7', '#f1f3f5', '#eef1f4', '#eef0f3', '#eceff1', '#eceff3',
  '#f0f6f8', '#e7f0f4', '#f5faff', '#eef3fb', '#f1f5fc',
]);
const neutralBorders = new Set([
  '#eee', '#e8e8e8', '#ddd', '#dfe4e9', '#edf0f3', '#e0e0e0',
  '#d9dfe5', '#e5e5e5', '#e6eefb', '#dde4e8', '#dfe3e8', '#cfd8dc',
  '#bac5ce', '#c5ced2', '#ececec', '#eef1f3',
]);
const primaryText = new Set(['#111', '#212121', '#202a35', '#222', '#24292f', '#263238', '#333', '#354251', '#172b35']);
const secondaryText = new Set(['#444', '#555', '#666', '#777', '#536170', '#697583', '#7c8793', '#78909c', '#546e7a', '#37474f', '#425966', '#64748b', '#98a2b3', '#626262', '#527b91', '#5076ad']);
const colorByMeaning: Record<string, string> = {
  '#a13e3b': '#ff8b86', '#c62828': '#ff8484', '#b32d2d': '#ff8585',
  '#b91c1c': '#ff8585', '#315f9b': '#8cbaff', '#1565c0': '#91c0ff',
  '#2563eb': '#91c0ff', '#2e7d32': '#79d68b', '#725400': '#e8bf69',
  '#7a4b00': '#e8bf69', '#8b641e': '#e8bf69', '#9a6700': '#e8bf69',
  '#7a5d00': '#e8bf69', '#995b16': '#e8bf69',
  '#6f4b00': '#e8bf69', '#8a6d00': '#e8bf69', '#a87920': '#e8bf69',
  '#245b76': '#9acbe2', '#1d4ed8': '#91c0ff', '#166534': '#79d68b',
  '#dc2626': '#ff8585', '#ef6c00': '#ffb270',
};
const tintedBackgrounds: Record<string, string> = {
  '#fff0f0': '#38232a', '#fef2f2': '#38232a', '#fcf3f2': '#38232a',
  '#f1d0d0': '#38232a', '#eef7ee': '#1d392b', '#f0fdf4': '#1d392b',
  '#e3f2fd': '#1c3045', '#eff6ff': '#1c3045', '#e6eefb': '#1c3045',
  '#fff8e1': '#3a3020', '#fff3cd': '#3a3020', '#fff5d9': '#3a3020',
  '#fff8c5': '#3a3020', '#fff8ed': '#3a3020',
};

export function themeColor(value: unknown, property: string, mode: AppearanceMode): unknown {
  if (mode === 'light' || typeof value !== 'string') return value;
  if (property === 'backgroundColor' && value.replace(/\s/gu, '').toLowerCase() === 'rgba(255,255,255,0.92)')
    return PALETTES.dark.surface;
  if (!value.startsWith('#')) return value;
  const code = value.toLowerCase();
  const colors = PALETTES.dark;
  if (property === 'color' || property === 'textDecorationColor' || property === 'tintColor') {
    if (primaryText.has(code)) return colors.text;
    if (secondaryText.has(code)) return colors.secondary;
    return colorByMeaning[code] ?? value;
  }
  if (property.toLowerCase().includes('border')) {
    return neutralBorders.has(code) || neutralBackgrounds.has(code) ? colors.border : (colorByMeaning[code] ?? value);
  }
  if (property === 'backgroundColor') {
    if (tintedBackgrounds[code]) return tintedBackgrounds[code];
    if (code === '#fff' || code === '#ffffff') return colors.screen;
    if (code === '#111' || code === '#202a35' || code === '#263238') return colors.selected;
    if (neutralBackgrounds.has(code) || neutralBorders.has(code)) return colors.surface;
  }
  return value;
}

type AnyStyle = ViewStyle & TextStyle & ImageStyle;
export function themeStyle<T extends ViewStyle | TextStyle | ImageStyle>(style: StyleProp<T>, mode: AppearanceMode): StyleProp<T> {
  if (mode === 'light' || !style) return style;
  const flat = StyleSheet.flatten(style) as Record<string, unknown> | undefined;
  if (!flat) return style;
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key === 'color' || key === 'textDecorationColor' || key === 'tintColor' || key === 'backgroundColor' || key.toLowerCase().includes('border') && key.toLowerCase().includes('color')) {
      const next = themeColor(value, key, mode);
      if (next !== value) overrides[key] = next;
    }
  }
  return Object.keys(overrides).length ? [style, overrides as AnyStyle] as StyleProp<T> : style;
}
