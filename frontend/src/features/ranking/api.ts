import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  PercentString,
  RateString,
  SectionState,
} from '../../models/dto/common';

export type RankingScope = 'all' | 'near_me' | 'top10';
export type RankingRankType = 'daily' | 'final';
export type MyRankingState = 'available' | 'not_joined' | 'unavailable';

export interface RankingUserDto {
  id: string;
  nickname: string;
}

export interface RankingItemDto {
  seasonParticipantId?: string;
  userId?: string;
  rank: number;
  tier?: string | null;
  provisionalTier?: string | null;
  finalTier?: string | null;
  returnRate: RateString;
  percentile?: PercentString | null;
  totalAssetKrw: MoneyString;
  user: RankingUserDto;
}

export interface MyRankingDto extends Partial<RankingItemDto> {
  state?: MyRankingState;
}

export interface RankingsResponseDto {
  state: SectionState;
  season?: {
    id?: string;
    name?: string;
    status?: string;
  } | null;
  rankType: RankingRankType;
  rankingDate?: string | null;
  capturedAt?: IsoDateTimeString | null;
  pagination: OffsetPagination;
  rankings: RankingItemDto[];
  myRanking?: MyRankingDto | null;
}

export interface UserSeasonSummaryDto {
  user: {
    id: string;
    nickname: string;
  };
  season: {
    rank?: number | null;
    tier?: string | null;
    provisionalTier?: string | null;
    finalTier?: string | null;
    returnRate?: RateString | null;
    percentile?: PercentString | null;
    totalAssetKrw?: MoneyString | null;
  };
  allocation: {
    cashKrwValue?: MoneyString | null;
    domesticStockValueKrw?: MoneyString | null;
    usStockValueKrw?: MoneyString | null;
    cryptoValueKrw?: MoneyString | null;
  };
  topPositions: Array<{
    assetId: string;
    symbol: string;
    name?: string;
    weight: string;
  }>;
}

export interface GetRankingsParams {
  scope: RankingScope;
  rankType?: RankingRankType;
  limit?: number;
  offset?: number;
  rankingDate?: string | null;
  capturedAt?: string | null;
}

function buildFallbackPagination(
  limit: number,
  offset: number,
  returned: number,
): OffsetPagination {
  return {
    limit,
    offset,
    total: offset + returned,
    returned,
    nextOffset: returned >= limit ? offset + returned : null,
  };
}

export function getRankingTier(
  item: Partial<RankingItemDto | MyRankingDto> | null | undefined,
  rankType?: RankingRankType,
) {
  if (rankType === 'final') {
    return item?.finalTier ?? item?.tier ?? '-';
  }

  return item?.provisionalTier ?? item?.tier ?? item?.finalTier ?? '-';
}

export async function getRankings(params: GetRankingsParams) {
  const limit = params.limit ?? (params.scope === 'top10' ? 10 : 50);
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();

  searchParams.set('scope', params.scope);
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));
  if (params.rankType) searchParams.set('rankType', params.rankType);
  if (params.rankingDate) searchParams.set('rankingDate', params.rankingDate);
  if (params.capturedAt) searchParams.set('capturedAt', params.capturedAt);

  const response = await apiClient.get<
    ApiSuccessResponse<
      RankingsResponseDto & {
        items?: RankingItemDto[];
        myRank?: MyRankingDto | null;
      }
    >
  >(`/ranking?${searchParams.toString()}`);

  const data = response.data.data;
  const rankings = data.rankings ?? data.items ?? [];

  return {
    ...data,
    state: data.state ?? 'available',
    rankings,
    myRanking: data.myRanking ?? data.myRank ?? null,
    pagination:
      data.pagination ?? buildFallbackPagination(limit, offset, rankings.length),
  };
}

export async function getUserSeasonSummary(userId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<UserSeasonSummaryDto>
  >(`/users/${userId}/season-summary`);

  return response.data.data;
}
