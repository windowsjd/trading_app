import type { AssetPriceErrorDto, AssetsResponseDto, MarketAssetItemDto } from './api';

/** Every listed US stock in one sort, with prices (see useMarketAssetSearch). */
export type ListedUsStocks = { assets: MarketAssetItemDto[]; priceErrors: AssetPriceErrorDto[] };

/**
 * Korean names live in the display layer (utils/usStockKoreanNames); the
 * server searches English names and symbols only. A search matching Korean
 * names therefore takes those listings — by their identity, market and
 * symbol — out of the whole US list (same sort, prices included) and puts
 * them before the server's own results of the first page, each asset once.
 */
export function prependKoreanNameMatches(
  page: AssetsResponseDto,
  listed: ListedUsStocks,
  matches: ReadonlyArray<{ market: string; symbol: string }>,
): AssetsResponseDto {
  if (!matches.length) return page;
  const wanted = new Set(matches.map(({ market, symbol }) => `${market}:${symbol}`));
  const found = listed.assets.filter((asset) => asset.assetType === 'us_stock'
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
