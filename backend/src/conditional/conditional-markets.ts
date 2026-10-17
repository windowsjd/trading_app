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

/**
 * Capability `offSessionMarkets` (2026-10-18): the supported stock markets
 * where a conditional BUY or SELL condition may also be registered while the
 * market is confirmed closed (the user chooses 이상/이하; watching starts in
 * the next regular session). Crypto Spot never closes, so it is not listed.
 */
export function conditionalOffSessionMarkets(
  env: Record<string, string | undefined> = process.env,
): Array<'KRX' | 'US'> {
  return conditionalMarkets(env).filter(
    (market): market is 'KRX' | 'US' => market !== 'CRYPTO_SPOT',
  );
}
