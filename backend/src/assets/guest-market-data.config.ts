const ASSET_TYPES = ['domestic_stock', 'us_stock', 'crypto'] as const;

export type GuestMarketDataAssetType = (typeof ASSET_TYPES)[number];

/**
 * Market data a signed-out visitor (the app's "로그인 없이 둘러보기") may read,
 * by asset type (2026-10-30). Dependency-free: startup validation and the
 * asset read services share this one parser.
 *
 * Unset or empty — the default — exposes nothing: every anonymous market read
 * keeps the existing 401, exactly as before guest browsing existed. A type is
 * listed only after the operator has confirmed that its price provider's
 * contract allows display to unauthenticated users (KOSCOM for domestic
 * stocks, Tiingo/KIS for US stocks, Binance for crypto, and the USD/KRW FX
 * sources behind KRW conversions). Only the account-free list/search, detail
 * and candle reads use it; every account, order, wallet, price and realtime
 * path still requires a token.
 *
 * Comma-separated exact values (`crypto` or `crypto,us_stock`); an unknown or
 * repeated value refuses to boot (env-validation.ts), so a typo is never read
 * as a deliberate scope.
 */
export function readGuestMarketDataAssetTypes(
  env: Record<string, string | undefined> = process.env,
): readonly GuestMarketDataAssetType[] {
  const raw = env.GUEST_MARKET_DATA_ASSET_TYPES?.trim() ?? '';
  if (!raw) return [];
  const values = raw.split(',').map((value) => value.trim());
  const types = values.filter((value): value is GuestMarketDataAssetType =>
    (ASSET_TYPES as readonly string[]).includes(value),
  );
  if (types.length !== values.length || new Set(types).size !== types.length)
    // @diagnosticSurface internal: Startup rejects an unreviewed guest market-data scope before serving requests.
    throw new Error(
      'GUEST_MARKET_DATA_ASSET_TYPES must list distinct values of domestic_stock, us_stock, crypto',
    );
  return types;
}
