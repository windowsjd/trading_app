import type { AppearanceMode } from './appearance';

export type FinancialColorPreference = 'red_blue' | 'green_red';
export const FINANCIAL_COLOR_STORAGE_KEY = 'trading-app:financial-colors';
export function parseFinancialColorPreference(value: string | null): FinancialColorPreference {
  return value === 'green_red' ? value : 'red_blue';
}

// Text/surfaces adapt to appearance. Red/Blue actions and candles share strong
// direction colors in both modes; Green retains its existing role policies.
const red = {
  text: { light: '#a13e3b', dark: '#ff8b86' },
  surface: { light: '#fef2f2', dark: '#38232a' },
  action: { light: '#d1110b', dark: '#d1110b' },
  candle: { light: '#d1110b', dark: '#d1110b' },
};
const blue = {
  text: { light: '#315f9b', dark: '#8cbaff' },
  surface: { light: '#eff6ff', dark: '#1e304b' },
  action: { light: '#0a5ac2', dark: '#0a5ac2' },
  candle: { light: '#0a5ac2', dark: '#0a5ac2' },
};
const green = {
  text: { light: '#16803a', dark: '#79d68b' },
  surface: { light: '#f0fdf4', dark: '#1d392b' },
  action: { light: '#16803a', dark: '#16803a' },
  candle: { light: '#16803a', dark: '#79d68b' },
};

function directionalPalette(positive: typeof red, negative: typeof red) {
  return {
    buy: positive.text, sell: negative.text, rise: positive.text, fall: negative.text,
    buySurface: positive.surface, sellSurface: negative.surface,
    buyAction: positive.action, sellAction: negative.action,
    candleUp: positive.candle, candleDown: negative.candle,
    // Cashflow is independent of market/order direction and of this preference.
    credit: { light: '#16803a', dark: '#79d68b' },
    debit: { light: '#bd3030', dark: '#ff8585' },
  };
}

export const FINANCIAL_PALETTES = {
  red_blue: directionalPalette(red, blue),
  green_red: directionalPalette(green, red),
};

// Explicit role tokens for themed native styles; never infer roles from hex.
export const financial = {
  buy: '#0e0001', sell: '#0e0002', rise: '#0e0003', fall: '#0e0004',
  buySurface: '#0e0005', sellSurface: '#0e0006',
  credit: '#0e0007', debit: '#0e0008',
  buyAction: '#0e0009', sellAction: '#0e000a',
  candleUp: '#0e000b', candleDown: '#0e000c',
} as const;
type Role = keyof typeof financial;
const roleByValue = Object.fromEntries(Object.entries(financial).map(([role, value]) => [value, role])) as Record<string, Role>;

export function getFinancialColors(mode: AppearanceMode, preference: FinancialColorPreference = 'red_blue'): Record<Role, string> {
  return Object.fromEntries(Object.entries(FINANCIAL_PALETTES[preference]).map(([role, color]) => [role, color[mode]])) as Record<Role, string>;
}

export function resolveFinancialColor(value: string, mode: AppearanceMode, preference: FinancialColorPreference = 'red_blue'): string {
  const role = roleByValue[value];
  return role ? FINANCIAL_PALETTES[preference][role][mode] : value;
}
