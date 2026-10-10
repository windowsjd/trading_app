import { useMemo, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { getAssets, type AssetType, type MarketAssetItemDto } from './api';
import { marketSortParams, nextMarketPage, type MarketSort } from './marketSort';

export type MarketSearchScope = AssetType | 'all';

export const MARKET_SEARCH_SCOPES: Array<{ key: MarketSearchScope; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'domestic_stock', label: '국내' },
  { key: 'us_stock', label: '미국' },
  { key: 'crypto', label: '암호화폐' },
];

/**
 * The one market search query shared by the search screen and the order
 * screen's asset sheet. An empty search is the existing asset list request;
 * each search text/scope/sort has its own cache key, so a slower earlier
 * response can never replace the rows of the current search.
 */
export function useMarketAssetSearch({ scope, searchText, sort, enabled }: {
  scope: MarketSearchScope;
  searchText: string;
  sort: MarketSort;
  enabled: boolean;
}) {
  const sortParams = marketSortParams(sort);
  const refreshSort = useRef(false);
  const trimmedSearchText = searchText.trim();
  const assetType = scope === 'all' ? undefined : scope;

  const searchQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.market.assets({
      ...sortParams,
      assetType,
      search: trimmedSearchText,
      withPrice: true,
      limit: 20,
      offset: 0,
    }),
    queryFn: ({ pageParam }) =>
      getAssets({
        ...sortParams,
        sortSnapshot: pageParam.sortSnapshot,
        sortRefresh: refreshSort.current && pageParam.offset === 0,
        assetType,
        search: trimmedSearchText || undefined,
        withPrice: true,
        offset: pageParam.offset,
        limit: 20,
      }),
    getNextPageParam: nextMarketPage,
    initialPageParam: { offset: 0 },
    enabled,
  });

  const items = useMemo(() => {
    const byId = new Map<string, MarketAssetItemDto>();

    searchQuery.data?.pages.forEach((page) => {
      page.assets.forEach((item) => {
        byId.set(item.id, item);
      });
    });

    return Array.from(byId.values());
  }, [searchQuery.data]);

  const hasPriceErrors = useMemo(
    () =>
      searchQuery.data?.pages.some(
        (page) => (page.priceErrors?.length ?? 0) > 0,
      ) ?? false,
    [searchQuery.data],
  );

  return { searchQuery, items, hasPriceErrors, trimmedSearchText, refreshSort };
}
