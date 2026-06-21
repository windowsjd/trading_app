import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  CursorPageResponse,
} from '../../models/dto/common';

export type RankingScope = 'all' | 'near_me' | 'top10';

export interface RankingUserDto {
  id: string;
  nickname: string;
}

export interface RankingItemDto {
  rank: number;
  tier: string;
  returnRate: string;
  totalAssetKrw: string;
  user: RankingUserDto;
}

export interface CurrentRankingsResponseDto extends CursorPageResponse<RankingItemDto> {
  myRank: RankingItemDto | null;
}

export interface NearMeRankingsResponseDto {
  myRank: RankingItemDto | null;
  items: RankingItemDto[];
}

export interface UserSeasonSummaryDto {
  user: {
    id: string;
    nickname: string;
  };
  season: {
    rank: number;
    tier: string;
    returnRate: string;
    totalAssetKrw: string;
  };
  allocation: {
    cashKrwValue: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
  };
  topPositions: Array<{
    assetId: string;
    symbol: string;
    weight: string;
  }>;
}

interface GetCurrentRankingsParams {
  scope: 'all' | 'top10';
  cursor?: string | null;
  limit?: number;
}

export async function getCurrentRankings(params: GetCurrentRankingsParams) {
  const searchParams = new URLSearchParams();
  searchParams.set('scope', params.scope);
  searchParams.set('limit', String(params.limit ?? (params.scope === 'top10' ? 10 : 50)));
  if (params.cursor) searchParams.set('cursor', params.cursor);

  const response = await apiClient.get<
    ApiSuccessResponse<CurrentRankingsResponseDto>
  >(`/rankings/current?${searchParams.toString()}`);

  return response.data.data;
}

export async function getNearMeRankings(size = 5) {
  const response = await apiClient.get<
    ApiSuccessResponse<NearMeRankingsResponseDto>
  >(`/rankings/current/near-me?size=${size}`);

  return response.data.data;
}

export async function getUserSeasonSummary(userId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<UserSeasonSummaryDto>
  >(`/users/${userId}/season-summary`);

  return response.data.data;
}