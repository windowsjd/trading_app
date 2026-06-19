import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  CursorPageResponse,
} from '../../models/dto/common';

export interface RecordSeasonListItemDto {
  seasonId: string;
  seasonName: string;
  joinedAt: string;
  finalRank: number;
  finalTier: string;
  finalReturnRate: string;
  finalTotalAssetKrw: string;
}

export interface RecordSeasonDetailDto {
  season: {
    id: string;
    name: string;
    startAt: string;
    endAt: string;
  };
  summary: {
    finalRank: number;
    finalTier: string;
    finalReturnRate: string;
    finalTotalAssetKrw: string;
    maxDrawdown: string;
    totalFillCount: number;
  };
  stats: {
    bestAsset: string | null;
    worstAsset: string | null;
  };
  equityChart: Array<{
    time: string;
    totalAssetKrw: string;
  }>;
}

export interface RecordOrderItemDto {
  orderId: string;
  executedAt: string;
  assetId: string;
  symbol: string;
  name: string;
  side: 'buy' | 'sell';
  quantity: string;
  fillPriceLocal: string;
  fillCurrency: 'KRW' | 'USD';
  netAmountLocal: string;
}

export interface RecordExchangeItemDto {
  exchangeId: string;
  executedAt: string;
  fromCurrency: 'KRW' | 'USD';
  toCurrency: 'KRW' | 'USD';
  sourceAmount: string;
  rate: string;
  feeAmount: string;
  feeCurrency: 'KRW' | 'USD';
  netTargetAmount: string;
}

export async function getMySeasonRecords(cursor?: string | null, limit = 20) {
  const searchParams = new URLSearchParams();
  if (cursor) searchParams.set('cursor', cursor);
  searchParams.set('limit', String(limit));

  const response = await apiClient.get<
    ApiSuccessResponse<CursorPageResponse<RecordSeasonListItemDto>>
  >(`/records/me/seasons?${searchParams.toString()}`);

  return response.data.data;
}

export async function getMySeasonRecordDetail(seasonId: string) {
  const response = await apiClient.get<ApiSuccessResponse<RecordSeasonDetailDto>>(
    `/records/me/seasons/${seasonId}`,
  );
  return response.data.data;
}

export async function getMySeasonOrders(
  seasonId: string,
  cursor?: string | null,
  limit = 20,
) {
  const searchParams = new URLSearchParams();
  if (cursor) searchParams.set('cursor', cursor);
  searchParams.set('limit', String(limit));

  const response = await apiClient.get<
    ApiSuccessResponse<CursorPageResponse<RecordOrderItemDto>>
  >(`/records/me/seasons/${seasonId}/orders?${searchParams.toString()}`);

  return response.data.data;
}

export async function getMySeasonExchanges(
  seasonId: string,
  cursor?: string | null,
  limit = 20,
) {
  const searchParams = new URLSearchParams();
  if (cursor) searchParams.set('cursor', cursor);
  searchParams.set('limit', String(limit));

  const response = await apiClient.get<
    ApiSuccessResponse<CursorPageResponse<RecordExchangeItemDto>>
  >(`/records/me/seasons/${seasonId}/exchanges?${searchParams.toString()}`);

  return response.data.data;
}