// `.ts` extension: this module is covered by `node --test`, which resolves ESM
// specifiers literally (the same convention as features/order/mapper.ts).
import { formatAssetPrice, type FormatCurrencyCode } from '../../utils/format.ts';

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
 */
export function formatChartPrice(
  value: number | string | null | undefined,
  currencyCode?: FormatCurrencyCode | null,
  displayPriceDecimals?: number | null,
): string {
  return formatAssetPrice(value, currencyCode, displayPriceDecimals);
}
