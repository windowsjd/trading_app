const ASSET_TYPES = ['domestic_stock', 'us_stock', 'crypto'] as const;
const SCOPES = [...ASSET_TYPES, 'crypto_futures'] as const;

export type GuestMarketDataAssetType = (typeof ASSET_TYPES)[number];
export type GuestMarketDataScope = (typeof SCOPES)[number];

/**
 * Market data a signed-out visitor (the app's "로그인 없이 둘러보기") may read,
 * by market (2026-10-30). Dependency-free: startup validation and the
 * market read services share this one parser.
 *
 * Unset or empty — the default — is every market: the operator confirmed
 * (2026-10-30) that the providers behind them (KOSCOM for domestic stocks,
 * Tiingo/KIS for US stocks, Binance Spot for crypto, Binance USDⓈ-M for
 * crypto_futures, and the USD/KRW FX sources behind KRW conversions) allow
 * display to signed-out visitors. A comma-separated list (`crypto` or
 * `crypto,crypto_futures`) narrows it, and `none` turns guest market data off:
 * every anonymous market read is then the 401 it was before guest browsing.
 *
 * Only account-free reads use it: the spot list/search, detail and candles
 * (the three asset types), and for crypto_futures the contract list, the
 * contract candles and the USD/KRW display rate of the contract's won figure.
 * Every account, order, wallet, position, price and realtime path still
 * requires a token.
 *
 * An unknown or repeated value (or `none` with others) refuses to boot
 * (env-validation.ts), so a typo is never read as a deliberate scope.
 */
export function readGuestMarketDataScopes(
  env: Record<string, string | undefined> = process.env,
): readonly GuestMarketDataScope[] {
  const raw = env.GUEST_MARKET_DATA_ASSET_TYPES?.trim() ?? '';
  if (!raw) return SCOPES;
  if (raw === 'none') return [];
  const values = raw.split(',').map((value) => value.trim());
  const scopes = values.filter((value): value is GuestMarketDataScope =>
    (SCOPES as readonly string[]).includes(value),
  );
  if (scopes.length !== values.length || new Set(scopes).size !== scopes.length)
    // @diagnosticSurface internal: Startup rejects an unreviewed guest market-data scope before serving requests.
    throw new Error(
      'GUEST_MARKET_DATA_ASSET_TYPES must be none or list distinct values of domestic_stock, us_stock, crypto, crypto_futures',
    );
  return scopes;
}

/** The spot asset types in the guest scope (list/search, detail, candles). */
export function readGuestMarketDataAssetTypes(
  env: Record<string, string | undefined> = process.env,
): readonly GuestMarketDataAssetType[] {
  return readGuestMarketDataScopes(env).filter(
    (scope): scope is GuestMarketDataAssetType =>
      (ASSET_TYPES as readonly string[]).includes(scope),
  );
}

/** Futures contract market data (list, candles, won display rate) in the guest scope. */
export function isGuestFuturesMarketDataEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readGuestMarketDataScopes(env).includes('crypto_futures');
}
