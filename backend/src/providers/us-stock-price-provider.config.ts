/**
 * Dependency-free (startup-validated) choice of the US stocks' single
 * financial price source (2026-10-17). `kis` (the default) keeps
 * `kis_us_delayed_trade`; `tiingo` switches every US workflow — display,
 * quote, execute, valuation, settlement, conditional triggers — to Tiingo's
 * persisted reference-price snapshots, with no KIS or admin_manual stand-in.
 * Startup validation rejects any other value and requires Tiingo's official
 * mode for `tiingo` (env-validation.ts).
 */
export type UsStockPriceProvider = 'kis' | 'tiingo';

export function readUsStockPriceProvider(
  env: Record<string, string | undefined> = process.env,
): UsStockPriceProvider {
  // Unset or empty (`US_STOCK_PRICE_PROVIDER=`) keeps the default.
  const value = env.US_STOCK_PRICE_PROVIDER?.trim() || 'kis';
  if (value !== 'kis' && value !== 'tiingo')
    // @diagnosticSurface internal: Startup rejects invalid fixed provider configuration before serving requests.
    throw new Error('US_STOCK_PRICE_PROVIDER must be kis or tiingo');
  return value;
}
