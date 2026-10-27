// `.ts` extension: this module is covered by `node --test`, which resolves ESM
// specifiers literally (the same convention as features/order/mapper.ts).
import { formatAssetPrice, normalizeCurrencyCode, type FormatCurrencyCode } from '../../utils/format.ts';

/**
 * The ONE price formatter for the candlestick chart.
 *
 * The y-axis labels, the current-price label, the crosshair price label and the
 * accessibility summary all go through it, so they can never disagree about
 * precision: a DOGE chart rounds at 5 places and shows $0.2456 everywhere
 * instead of a $0.25 axis next to a $0.2456 header.
 *
 * Unlike the header price, the values arriving here are COMPUTED floats — an
 * interpolated grid value, the price under the crosshair — so they carry float
 * noise that must still be rendered at the asset's declared precision.
 *
 * Display only: a formatted string is lossy and must never be fed back into
 * price math or an order request.
 *
 * `displayRate` converts a price into the chart's display currency (the won
 * view of a dollar asset, see wonChartDisplay). A converted won price keeps
 * the precision the chart carried over, so a low-priced coin reads 0.01384원
 * rather than an axis of 0원; a won price of its own stays whole won whatever
 * precision is declared.
 */
export function formatChartPrice(
  value: number | string | null | undefined,
  currencyCode?: FormatCurrencyCode | null,
  displayPriceDecimals?: number | null,
  displayRate?: number | null,
): string {
  if (displayRate == null) return formatAssetPrice(value, currencyCode, displayPriceDecimals);
  const converted = value == null || value === '' ? null : Number(value) * displayRate;
  if (normalizeCurrencyCode(currencyCode) === 'KRW' && (displayPriceDecimals ?? 0) > 0) {
    const digits = formatAssetPrice(converted, null, displayPriceDecimals);
    return digits === '-' ? digits : `${digits}원`;
  }
  return formatAssetPrice(converted, currencyCode, displayPriceDecimals);
}
