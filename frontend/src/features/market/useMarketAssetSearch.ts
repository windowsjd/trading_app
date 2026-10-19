import { useMemo, useRef } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { findKrStocksByKoreanName } from '../../utils/krStockKoreanNames';
import { findUsStocksByKoreanName } from '../../utils/usStockKoreanNames';
import { getAssets, type AssetType, type MarketAssetItemDto } from './api';
import { prependKoreanNameMatches, type ListedStocks } from './koreanNameSearch';
import { marketSortParams, nextMarketPage, type MarketPageParam, type MarketSort } from './marketSort';

export type MarketSearchScope = AssetType | 'all';

export const MARKET_SEARCH_SCOPES: Array<{ key: MarketSearchScope; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'domestic_stock', label: '국내' },
  { key: 'us_stock', label: '미국' },
  { key: 'crypto', label: '암호화폐' },
];

/** Kept under 30 s: one list per stock type serves every keystroke of a Korean search. */
const KOREAN_NAME_INDEX_STALE_MS = 30_000;

type NamedStockType = 'us_stock' | 'domestic_stock';

/** Every listed stock of one type in the search's sort (universes of 100 and 70; pages of 100). */
async function fetchListedStocks(assetType: NamedStockType, sort: ReturnType<typeof marketSortParams>,
  sortRefresh: boolean): Promise<ListedStocks> {
  const listed: ListedStocks = { assets: [], priceErrors: [] };
  let page: MarketPageParam | undefined = { offset: 0 };
  // Bounded: a runaway pagination can never loop the search.
  for (let index = 0; page && index < 5; index++) {
    const response = await getAssets({
      ...sort, sortSnapshot: page.sortSnapshot, sortRefresh: sortRefresh && index === 0,
      assetType, withPrice: true, limit: 100, offset: page.offset,
    });
    listed.assets.push(...response.assets);
    listed.priceErrors.push(...(response.priceErrors ?? []));
    page = nextMarketPage(response);
  }
  return listed;
}

/**
 * The one market search query shared by the search screen and the order
 * screen's asset sheet. An empty search is the existing asset list request;
 * each search text/scope/sort has its own cache key, so a slower earlier
 * response can never replace the rows of the current search.
 *
 * A text matching the Korean names of US stocks (애플, 엔비디아…) or KRX
 * stocks (삼성전자, 현대차…) also lists those stocks first: the server knows
 * only English names and symbols, so they are taken from the whole US/KRX list
 * by market and symbol (koreanNameSearch).
 */
export function useMarketAssetSearch({ scope, searchText, sort, enabled }: {
  scope: MarketSearchScope;
  searchText: string;
  sort: MarketSort;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const sortParams = marketSortParams(sort);
  const refreshSort = useRef(false);
  const trimmedSearchText = searchText.trim();
  const assetType = scope === 'all' ? undefined : scope;
  const koreanMatches = useMemo(
    () => [
      ...(scope === 'all' || scope === 'us_stock' ? findUsStocksByKoreanName(trimmedSearchText) : []),
      ...(scope === 'all' || scope === 'domestic_stock' ? findKrStocksByKoreanName(trimmedSearchText) : []),
    ],
    [scope, trimmedSearchText],
  );

  const searchQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.market.assets({
      ...sortParams,
      assetType,
      search: trimmedSearchText,
      withPrice: true,
      limit: 20,
      offset: 0,
    }),
    queryFn: async ({ pageParam }) => {
      const sortRefresh = refreshSort.current && pageParam.offset === 0;
      const page = await getAssets({
        ...sortParams,
        sortSnapshot: pageParam.sortSnapshot,
        sortRefresh,
        assetType,
        search: trimmedSearchText || undefined,
        withPrice: true,
        offset: pageParam.offset,
        limit: 20,
      });
      if (pageParam.offset !== 0 || !koreanMatches.length) return page;
      const types = [...new Set(koreanMatches.map((match): NamedStockType => (match.market === 'KRX' ? 'domestic_stock' : 'us_stock')))];
      const lists = await Promise.all(types.map((type) => queryClient.fetchQuery({
        queryKey: QUERY_KEYS.market.koreanNameIndex({ ...sortParams, assetType: type }),
        queryFn: () => fetchListedStocks(type, sortParams, sortRefresh),
        // A pull to refresh reloads it with the rows.
        staleTime: sortRefresh ? 0 : KOREAN_NAME_INDEX_STALE_MS,
      })));
      const listed: ListedStocks = { assets: lists.flatMap((list) => list.assets), priceErrors: lists.flatMap((list) => list.priceErrors) };
      return prependKoreanNameMatches(page, listed, koreanMatches);
    },
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
