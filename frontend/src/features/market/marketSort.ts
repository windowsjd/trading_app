import type { AssetsResponseDto } from './api';

export const MARKET_SORTS = [
  { value: 'volume_desc', label: '거래량 높은순', sortBy: 'volume', sortOrder: 'desc' },
  { value: 'change_desc', label: '등락률 높은순', sortBy: 'changeRate', sortOrder: 'desc' },
  { value: 'change_asc', label: '등락률 낮은순', sortBy: 'changeRate', sortOrder: 'asc' },
] as const;
export type MarketSort = typeof MARKET_SORTS[number]['value'];
export const marketSortParams = (value: MarketSort) => {
  const { sortBy, sortOrder } = MARKET_SORTS.find((sort) => sort.value === value) ?? MARKET_SORTS[0];
  return { sortBy, sortOrder };
};
export type MarketPageParam = { offset: number; sortSnapshot?: string };
export function nextMarketPage(page: AssetsResponseDto): MarketPageParam | undefined {
  return page.pagination.nextOffset == null ? undefined : {
    offset: page.pagination.nextOffset,
    sortSnapshot: page.sortSnapshot,
  };
}
