import { financial } from '../../theme/financialColors.ts';
import { semantic } from '../../theme/tokens.ts';
import {
  formatKrwDecimal,
  formatMoneyDecimal,
  formatPercent,
  normalizeCurrencyCode,
} from '../../utils/format.ts';

export type OrderRealizedPnlDisplay =
  | { available: true; text: string; color: string }
  | { available: false };

/**
 * A SELL fill's realized PnL in the order history (2026-11-06): the server's
 * stored per-order figure in the order's currency, never derived here. A
 * missing figure (a sell from before it was recorded, or a server that does
 * not send it) is unavailable — never 0. As in getRecordFinancialDisplay, a
 * figure that rounds to 0 for display takes the neutral color.
 */
export function getOrderRealizedPnlDisplay(
  value: string | null | undefined,
  currencyCode: string | null | undefined,
): OrderRealizedPnlDisplay {
  const code = normalizeCurrencyCode(currencyCode);
  if (!code || typeof value !== 'string' || !/^[+-]?\d+(\.\d+)?$/u.test(value)) {
    return { available: false };
  }
  const text = formatMoneyDecimal(value, code, true);
  return {
    available: true,
    text,
    color: text.startsWith('+') ? financial.rise : text.startsWith('-') ? financial.fall : semantic.text,
  };
}

/** Presentation only. API rates are already percentages; never rescale them. */
export function getRecordFinancialDisplay(
  value: string | null | undefined,
  kind: 'money' | 'rate' = 'money',
  signed = true,
) {
  if (value === null || value === undefined || value.trim() === '' || !Number.isFinite(Number(value))) {
    return { text: '-', color: semantic.text };
  }
  const formatted = kind === 'rate' ? formatPercent(value) : formatKrwDecimal(value);
  if (formatted === '-') return { text: '-', color: semantic.text };
  const sign = Number(value);
  // A value that rounds to 0 for display (0.001% → 0%) reads as zero, so it
  // takes the neutral color like an exact zero instead of a direction.
  const shownAsZero = formatted === '0';
  return {
    text: `${signed && sign > 0 && !shownAsZero ? '+' : ''}${formatted}${kind === 'rate' ? '%' : '원'}`,
    color: !signed || sign === 0 || shownAsZero ? semantic.text : sign > 0 ? financial.rise : financial.fall,
  };
}
