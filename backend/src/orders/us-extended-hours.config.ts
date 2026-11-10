import { readUsStockPriceProvider } from '../providers/us-stock-price-provider.config';

/**
 * US stock pre-market / after-hours switches (2026-11-10). Both default to
 * false, and with both false every US workflow keeps the regular-session-only
 * policy byte for byte.
 *
 * - US_STOCK_EXTENDED_HOURS_PRICE_ENABLED: the Tiingo collector also stores
 *   pre-market/after-hours reference prices (their own source name), and the
 *   display and live-valuation reads (assets, home, positions, live
 *   portfolio/ranking) show them. Daily snapshots, Season settlement, LOC,
 *   candles and conditional/TP-SL triggers never read them. Requires
 *   US_STOCK_PRICE_PROVIDER=tiingo (whose own startup check requires Tiingo's
 *   official mode).
 * - US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED: the scheduler matcher's
 *   path A also fills submitted US limit orders on a fresh extended-hours
 *   price. Requires the price switch; it only acts while the existing
 *   matcher runs (SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED). It also lets the
 *   matcher prepare USD/KRW once per cycle (the shared, bounded
 *   UsdKrwRefreshService) before any US stock limit fill — regular session
 *   included — so a fill is not left waiting for an FX row ≤ 60 s old; the
 *   fill still re-selects that evidence itself.
 *
 * Dependency-free apart from the dependency-free provider parser, so startup
 * validation, providers and orders can all read it without a cycle.
 */
export type UsExtendedHoursConfig = {
  priceEnabled: boolean;
  limitMatchingEnabled: boolean;
};

export const US_EXTENDED_HOURS_PRICE_FLAG =
  'US_STOCK_EXTENDED_HOURS_PRICE_ENABLED';
export const US_EXTENDED_HOURS_LIMIT_MATCHING_FLAG =
  'US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED';

export class UsExtendedHoursConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsExtendedHoursConfigError';
  }
}

/** Strict: a typo never reads as "off" (startup refuses to boot instead). */
export function readUsExtendedHoursConfig(
  env: NodeJS.ProcessEnv = process.env,
): UsExtendedHoursConfig {
  const priceEnabled = flag(env, US_EXTENDED_HOURS_PRICE_FLAG);
  const limitMatchingEnabled = flag(env, US_EXTENDED_HOURS_LIMIT_MATCHING_FLAG);
  if (priceEnabled && readUsStockPriceProvider(env) !== 'tiingo')
    // @diagnosticSurface internal: Startup rejects extended-hours prices without their only collector.
    throw new UsExtendedHoursConfigError(
      `${US_EXTENDED_HOURS_PRICE_FLAG}=true requires US_STOCK_PRICE_PROVIDER=tiingo (the only collector of extended-hours prices).`,
    );
  if (limitMatchingEnabled && !priceEnabled)
    // @diagnosticSurface internal: Startup rejects extended-hours fills without extended-hours prices.
    throw new UsExtendedHoursConfigError(
      `${US_EXTENDED_HOURS_LIMIT_MATCHING_FLAG}=true requires ${US_EXTENDED_HOURS_PRICE_FLAG}=true.`,
    );
  return { priceEnabled, limitMatchingEnabled };
}

/** Extended-hours prices are collected and shown. */
export function usExtendedHoursPriceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readUsExtendedHoursConfig(env).priceEnabled;
}

/**
 * The matcher may fill US limit orders on extended-hours evidence. Validation
 * makes this imply the price switch and the Tiingo provider; it acts only
 * inside a running matcher, so clients see it combined with the matcher's
 * own switches (order capabilities).
 */
export function usExtendedHoursLimitMatchingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readUsExtendedHoursConfig(env).limitMatchingEnabled;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  // @diagnosticSurface internal: Startup rejects a misspelled extended-hours switch before serving requests.
  throw new UsExtendedHoursConfigError(
    `${name} must be one of true, false, 1, 0 (case-insensitive), or be omitted for the default false. Received: ${JSON.stringify(raw)}.`,
  );
}
