export type BinanceFixedAssetUniverseEntry = {
  /** Binance Spot trading symbol as returned by exchangeInfo, e.g. `BTCUSDT`. */
  symbol: string;
  /** Spot base asset, e.g. `BTC`. Must equal exchangeInfo `baseAsset`. */
  baseAsset: string;
  name: string;
  /** Stored in `assets.market`; the provider target resolver keys on `BINANCE`. */
  market: 'BINANCE';
  assetType: 'crypto';
  /**
   * Internal settlement/pricing currency. MVP treats Binance USDT quote pairs
   * as USD-equivalent, so crypto is stored as `USD` and NO `CurrencyCode.USDT`
   * enum is introduced. See docs/provider-ingestion-foundation.md.
   */
  currencyCode: 'USD';
  priceCurrency: 'USD';
  settlementCurrency: 'USD';
};

/**
 * Fixed 10-symbol Binance Spot crypto MVP universe.
 *
 * Selection (reviewed, static — NOT an auto-updating market-cap feed):
 * - Selection date: 2026-07-25.
 * - BTC and ETH are pre-existing project symbols; the other 8 are additions.
 * - Additions exclude stablecoins and wrapped/pegged assets (only "native"
 *   large-cap L1/L2/utility tokens).
 * - Binance Spot USDT trading-pair support (`<BASE>USDT`, status `TRADING`) is a
 *   hard requirement, verified against `GET /api/v3/exchangeInfo` before any DB
 *   write by scripts/seed-binance-fixed-asset-universe.ts.
 * - Market-cap ranking drifts over time, so this list is maintained as a
 *   curated fixed MVP universe rather than a dynamic list.
 *
 * `symbol` is the real Binance trading symbol (`BTCUSDT` form). The provider
 * target resolver and price ingestion both accept the `BTCUSDT` symbol
 * directly, and crypto candle normalization keeps `BTCUSDT` unchanged, so one
 * stored symbol serves price, candles, and scheduler targeting.
 */
export const BINANCE_FIXED_ASSET_UNIVERSE: readonly BinanceFixedAssetUniverseEntry[] =
  [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      name: 'Bitcoin',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      name: 'Ethereum',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'BNBUSDT',
      baseAsset: 'BNB',
      name: 'BNB',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'XRPUSDT',
      baseAsset: 'XRP',
      name: 'XRP',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'SOLUSDT',
      baseAsset: 'SOL',
      name: 'Solana',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'TRXUSDT',
      baseAsset: 'TRX',
      name: 'TRON',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'DOGEUSDT',
      baseAsset: 'DOGE',
      name: 'Dogecoin',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'ZECUSDT',
      baseAsset: 'ZEC',
      name: 'Zcash',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'XLMUSDT',
      baseAsset: 'XLM',
      name: 'Stellar',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'LINKUSDT',
      baseAsset: 'LINK',
      name: 'Chainlink',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  ];

/** `BTCUSDT`-form Spot symbols; also a valid `BINANCE_CRYPTO_SYMBOLS` default. */
export const BINANCE_FIXED_SYMBOLS: readonly string[] =
  BINANCE_FIXED_ASSET_UNIVERSE.map((entry) => entry.symbol);
