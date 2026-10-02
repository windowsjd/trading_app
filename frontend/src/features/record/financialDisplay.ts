import { financial } from '../../theme/financialColors.ts';
import { semantic } from '../../theme/tokens.ts';
import { formatKrwDecimal, formatPercent } from '../../utils/format.ts';

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
  return {
    text: `${signed && sign > 0 && formatted !== '0' ? '+' : ''}${formatted}${kind === 'rate' ? '%' : '원'}`,
    color: !signed || sign === 0 ? semantic.text : sign > 0 ? financial.rise : financial.fall,
  };
}
