import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  CursorPageResponse,
} from '../../models/dto/common';

export type AssetClass = 'domestic_stock' | 'us_stock' | 'crypto';

export interface MarketAssetItemDto {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  market: string;
  currentPrice: string;
  priceCurrency: 'KRW' | 'USD';
  changeRate: string;
  volume24h?: string;
}

export interface GetAssetsParams {
  assetClass: AssetClass;
  query?: string;
  sort?: 'volume' | 'change' | 'market_cap';
  cursor?: string | null;
  limit?: number;
}

export async function getAssets(params: GetAssetsParams) {
  const searchParams = new URLSearchParams();
  searchParams.set('assetClass', params.assetClass);
  if (params.query) searchParams.set('query', params.query);
  if (params.sort) searchParams.set('sort', params.sort);
  if (params.cursor) searchParams.set('cursor', params.cursor);
  searchParams.set('limit', String(params.limit ?? 20));

  const response = await apiClient.get<
    ApiSuccessResponse<CursorPageResponse<MarketAssetItemDto>>
  >(`/assets?${searchParams.toString()}`);

  return response.data.data;
}