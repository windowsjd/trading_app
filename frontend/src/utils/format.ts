// Display-only number formatting. Never use these on values before sending
// them back to the API — they are lossy (rounded) by design.

export type FormatCurrencyCode = 'KRW' | 'USD' | string;

function toFiniteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function withThousandsSeparator(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** KRW/원 display: rounded to an integer, thousands-separated. No currency symbol. */
export function formatKrw(value: string | number | null | undefined): string {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return '-';

  const rounded = Math.round(parsed);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${withThousandsSeparator(String(Math.abs(rounded)))}`;
}

/** USD display: fixed to 2 decimal places, thousands-separated. No currency symbol. */
export function formatUsd(value: string | number | null | undefined): string {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return '-';

  const sign = parsed < 0 ? '-' : '';
  const [integerPart, decimalPart] = Math.abs(parsed).toFixed(2).split('.');
  return `${sign}${withThousandsSeparator(integerPart)}.${decimalPart}`;
}

/** Picks formatKrw/formatUsd based on currencyCode; defaults to KRW-style for unknown codes. */
export function formatCurrency(
  value: string | number | null | undefined,
  currencyCode?: FormatCurrencyCode | null,
): string {
  return currencyCode === 'USD' ? formatUsd(value) : formatKrw(value);
}

/** Percent/return-rate display: fixed decimal places (default 2), no thousands separator, no '%'. */
export function formatPercent(
  value: string | number | null | undefined,
  digits = 2,
): string {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return '-';
  return parsed.toFixed(digits);
}

export type AssetNameDisplay = {
  primary: string;
  secondary: string | null;
};

/**
 * Name-first display for an asset: company/coin name as primary, symbol as
 * secondary. Falls back to symbol as primary when name is missing.
 */
export function getAssetNameDisplay(
  asset?: { name?: string | null; symbol?: string | null } | null,
): AssetNameDisplay {
  const name = asset?.name?.trim() || null;
  const symbol = asset?.symbol?.trim() || null;

  if (name && symbol && name !== symbol) return { primary: name, secondary: symbol };
  if (name) return { primary: name, secondary: null };
  // TODO: asset.name is missing from this payload; falling back to symbol only.
  if (symbol) return { primary: symbol, secondary: null };
  return { primary: '-', secondary: null };
}
