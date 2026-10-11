import type { Prisma } from '../../generated/prisma/client';
import { BINANCE_FIXED_ASSET_UNIVERSE } from './binance-fixed-asset-universe';

/** 2026-10-11 approved YTD selection. Exact USDT identities; no aliases. */
export const BINANCE_FUTURES_SYMBOLS: readonly string[] = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'ZECUSDT',
  'XRPUSDT',
  'HYPEUSDT',
  'DOGEUSDT',
  'BNBUSDT',
  'SUIUSDT',
  'NEARUSDT',
  'ADAUSDT',
  'WLDUSDT',
  'TAOUSDT',
  'ENAUSDT',
  'LINKUSDT',
  'AVAXUSDT',
  'UNIUSDT',
  'PUMPUSDT',
  'BCHUSDT',
  'TRUMPUSDT',
  'FILUSDT',
  'AAVEUSDT',
  'LTCUSDT',
  'ASTERUSDT',
  'XLMUSDT',
];
const futuresSymbols = new Set(BINANCE_FUTURES_SYMBOLS);
const spotSymbols = new Set(
  BINANCE_FIXED_ASSET_UNIVERSE.map((row) => row.symbol),
);
export const BINANCE_FUTURES_ONLY_SYMBOLS = BINANCE_FUTURES_SYMBOLS.filter(
  (symbol) => !spotSymbols.has(symbol),
);
// Reject legacy base-form Spot inputs too; Futures never maps aliases.
const spotExcludedSymbols = BINANCE_FUTURES_ONLY_SYMBOLS.flatMap((symbol) => [
  symbol,
  symbol.slice(0, -4),
]);
const spotExcluded = new Set(spotExcludedSymbols);
export function isOfferedFuturesSymbol(symbol: string): boolean {
  return futuresSymbols.has(symbol);
}
export function isFuturesOnlySymbol(symbol: string): boolean {
  return spotExcluded.has(symbol);
}
export function isFuturesOnlyAsset(asset: {
  symbol: string;
  market: string;
  assetType: string;
}): boolean {
  return (
    asset.market === 'BINANCE' &&
    asset.assetType === 'crypto' &&
    isFuturesOnlySymbol(asset.symbol)
  );
}
/** Operational isActive is independent of Spot availability. Historical holdings
 * and financial reads retain their IDs; only Spot discovery/entry/providers use this. */
export const SPOT_ASSET_WHERE: Prisma.AssetWhereInput = {
  NOT: {
    market: 'BINANCE',
    assetType: 'crypto',
    symbol: { in: spotExcludedSymbols },
  },
};

export const BINANCE_FUTURES_ONLY_ASSETS = [
  { symbol: 'HYPEUSDT', name: 'Hyperliquid' },
  { symbol: 'PUMPUSDT', name: 'Pump.Fun' },
  { symbol: 'BCHUSDT', name: 'Bitcoin Cash' },
  { symbol: 'FILUSDT', name: 'Filecoin' },
  { symbol: 'AAVEUSDT', name: 'Aave' },
] as const;

/** FAPI PRICE_FILTER fallback from the selection evidence, never Spot ticks.
 * Fresh validated exchangeInfo metadata takes precedence in the presenter. */
export const FUTURES_DISPLAY_DECIMALS: Readonly<Record<string, number>> = {
  BTCUSDT: 1,
  ETHUSDT: 2,
  SOLUSDT: 2,
  ZECUSDT: 2,
  XRPUSDT: 4,
  HYPEUSDT: 3,
  DOGEUSDT: 5,
  BNBUSDT: 2,
  SUIUSDT: 4,
  NEARUSDT: 3,
  ADAUSDT: 4,
  WLDUSDT: 4,
  TAOUSDT: 2,
  ENAUSDT: 5,
  LINKUSDT: 3,
  AVAXUSDT: 3,
  UNIUSDT: 3,
  PUMPUSDT: 6,
  BCHUSDT: 2,
  TRUMPUSDT: 3,
  FILUSDT: 4,
  AAVEUSDT: 2,
  LTCUSDT: 2,
  ASTERUSDT: 4,
  XLMUSDT: 5,
};
