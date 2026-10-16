import { readUsStockPriceProvider } from '../providers/us-stock-price-provider.config';

/**
 * US stocks join conditional orders (conditional BUY/SELL, independent and
 * entry stop-loss/take-profit) only while their financial price source is the
 * approved provider, Tiingo (2026-10-17). The rules themselves (registration,
 * watch, trigger evidence, reservation, execution) are the same for every
 * market and are not relaxed.
 */
export function usConditionalOrdersSupported(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readUsStockPriceProvider(env) === 'tiingo';
}

/** Capability `markets` of the conditional lists: KRX, crypto Spot, then US when supported. */
export function conditionalMarkets(
  env: Record<string, string | undefined> = process.env,
): Array<'KRX' | 'CRYPTO_SPOT' | 'US'> {
  return [
    'KRX',
    'CRYPTO_SPOT',
    ...(usConditionalOrdersSupported(env) ? (['US'] as const) : []),
  ];
}
