import type { AppearanceMode } from './appearance';

/** Financial presentation only. Order sides, price changes and candle direction
 * have separate meanings, even when their current hues happen to match.
 * Solid actions/candles retain their tones in both modes; text/surfaces adapt
 * for contrast. None of these colors participate in financial calculations. */
export const FINANCIAL_COLORS = {
  buy: { light: '#16a34a', dark: '#79d68b' },
  sell: { light: '#dc2626', dark: '#ff8585' },
  rise: { light: '#a13e3b', dark: '#ff8b86' },
  fall: { light: '#315f9b', dark: '#8cbaff' },
  buySurface: { light: '#f0fdf4', dark: '#1d392b' },
  sellSurface: { light: '#fef2f2', dark: '#38232a' },
  credit: { light: '#16803a', dark: '#79d68b' },
  debit: { light: '#bd3030', dark: '#ff8585' },
  buyAction: '#16a34a',
  sellAction: '#dc2626',
  candleUp: '#16a34a',
  candleDown: '#dc2626',
} as const;

// Explicit role tokens for themed native styles; never infer roles from hex.
export const financial = {
  buy: '#0e0001', sell: '#0e0002', rise: '#0e0003', fall: '#0e0004',
  buySurface: '#0e0005', sellSurface: '#0e0006',
  credit: '#0e0007', debit: '#0e0008',
} as const;
type Role = keyof typeof financial;
const roleByValue = Object.fromEntries(Object.entries(financial).map(([role, value]) => [value, role])) as Record<string, Role>;
export function resolveFinancialColor(value: string, mode: AppearanceMode): string {
  const role = roleByValue[value];
  return role ? FINANCIAL_COLORS[role][mode] : value;
}
