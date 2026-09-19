/**
 * `assets.market` value for every Binance Spot asset. Declared in this pure
 * module so precision/metadata code can key on it without importing the
 * Prisma-bound ingestion module; `BINANCE_MARKET` re-exports this value.
 */
export const BINANCE_ASSET_MARKET = 'BINANCE';

export type BinanceFixedAssetUniverseEntry = {
  /** Binance Spot trading symbol as returned by exchangeInfo, e.g. `BTCUSDT`. */
  symbol: string;
  /**
   * Last reviewed `PRICE_FILTER.tickSize` for this symbol. This is a FALLBACK
   * only: BinanceSymbolMetadataService prefers the live exchangeInfo value and
   * uses this constant when the provider is disabled or unreachable.
   * `scripts/binance-fixed-universe-smoke.ts` verifies it against the real API.
   */
  priceTickSize: string;
  /** Display decimals derived from `priceTickSize` (fallback, see above). */
  displayPriceDecimals: number;
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
 * Fixed 25-symbol Binance Spot crypto universe.
 *
 * Keeps the original ten contracts; adds the top fifteen eligible symbols by
 * 2026-01-01 <= UTC day < 2026-09-19 cumulative Spot USDT quote volume.
 * Stablecoins, wrapped/pegged assets and derivative representations are excluded.
 * Research, exact volumes and official metadata: docs/binance-universe-2026-ytd.md.
 * This is a curated fixed list, never an automatic ranking or rotation feed.
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
      priceTickSize: '0.01000000',
      displayPriceDecimals: 2,
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
      priceTickSize: '0.01000000',
      displayPriceDecimals: 2,
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
      priceTickSize: '0.01000000',
      displayPriceDecimals: 2,
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
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
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
      priceTickSize: '0.01000000',
      displayPriceDecimals: 2,
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
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
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
      priceTickSize: '0.00001000',
      displayPriceDecimals: 5,
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
      priceTickSize: '0.01000000',
      displayPriceDecimals: 2,
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
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
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
      priceTickSize: '0.00100000',
      displayPriceDecimals: 3,
      baseAsset: 'LINK',
      name: 'Chainlink',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'SUIUSDT',
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
      baseAsset: 'SUI',
      name: 'Sui',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'NIGHTUSDT',
      priceTickSize: '0.00001000',
      displayPriceDecimals: 5,
      baseAsset: 'NIGHT',
      name: 'Midnight',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'NEARUSDT',
      priceTickSize: '0.00100000',
      displayPriceDecimals: 3,
      baseAsset: 'NEAR',
      name: 'NEAR Protocol',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'PEPEUSDT',
      priceTickSize: '0.00000001',
      displayPriceDecimals: 8,
      baseAsset: 'PEPE',
      name: 'Pepe',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'ADAUSDT',
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
      baseAsset: 'ADA',
      name: 'Cardano',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'TAOUSDT',
      priceTickSize: '0.10000000',
      displayPriceDecimals: 1,
      baseAsset: 'TAO',
      name: 'Bittensor',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'WLDUSDT',
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
      baseAsset: 'WLD',
      name: 'Worldcoin',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'ENAUSDT',
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
      baseAsset: 'ENA',
      name: 'Ethena',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'AVAXUSDT',
      priceTickSize: '0.00100000',
      displayPriceDecimals: 3,
      baseAsset: 'AVAX',
      name: 'Avalanche',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'UNIUSDT',
      priceTickSize: '0.00100000',
      displayPriceDecimals: 3,
      baseAsset: 'UNI',
      name: 'Uniswap',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'CHIPUSDT',
      priceTickSize: '0.00001000',
      displayPriceDecimals: 5,
      baseAsset: 'CHIP',
      name: 'USD.AI',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'LTCUSDT',
      priceTickSize: '0.01000000',
      displayPriceDecimals: 2,
      baseAsset: 'LTC',
      name: 'Litecoin',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'ASTERUSDT',
      priceTickSize: '0.00100000',
      displayPriceDecimals: 3,
      baseAsset: 'ASTER',
      name: 'Aster',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: '币安人生USDT',
      priceTickSize: '0.00010000',
      displayPriceDecimals: 4,
      baseAsset: '币安人生',
      name: '币安人生',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
    {
      symbol: 'TRUMPUSDT',
      priceTickSize: '0.00100000',
      displayPriceDecimals: 3,
      baseAsset: 'TRUMP',
      name: 'OFFICIAL TRUMP',
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
