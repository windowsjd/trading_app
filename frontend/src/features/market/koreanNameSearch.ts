import type { AssetPriceErrorDto, AssetsResponseDto, MarketAssetItemDto } from './api';

/** Every listed stock of the searched types in one sort, with prices (see useMarketAssetSearch). */
export type ListedStocks = { assets: MarketAssetItemDto[]; priceErrors: AssetPriceErrorDto[] };

const STOCK_TYPES = new Set<MarketAssetItemDto['assetType']>(['us_stock', 'domestic_stock']);

/**
 * Korean names live in the display layer (utils/usStockKoreanNames,
 * utils/krStockKoreanNames); the server searches English names and symbols
 * only. A search matching Korean names therefore takes those listings — by
 * their identity, market and symbol — out of the whole US/KRX lists (same
 * sort, prices included) and puts them before the server's own results of
 * the first page, each asset once.
 */
export function prependKoreanNameMatches(
  page: AssetsResponseDto,
  listed: ListedStocks,
  matches: ReadonlyArray<{ market: string; symbol: string }>,
): AssetsResponseDto {
  if (!matches.length) return page;
  const wanted = new Set(matches.map(({ market, symbol }) => `${market}:${symbol}`));
  const found = listed.assets.filter((asset) => STOCK_TYPES.has(asset.assetType)
    && wanted.has(`${asset.market.trim().toUpperCase()}:${asset.symbol.trim().toUpperCase()}`));
  if (!found.length) return page;
  const ids = new Set(found.map((asset) => asset.id));
  return {
    ...page,
    assets: [...found, ...page.assets.filter((asset) => !ids.has(asset.id))],
    priceErrors: [
      ...listed.priceErrors.filter((error) => ids.has(error.assetId)),
      ...(page.priceErrors ?? []).filter((error) => !ids.has(error.assetId)),
    ],
  };
}
