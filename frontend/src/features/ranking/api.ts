import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  PercentString,
  RateString,
} from '../../models/dto/common';
import type { SeasonStatus } from '../../models/dto/season';

export type RankingScope = 'all' | 'near_me' | 'top10';
export type RankingRankType = 'daily' | 'final';
interface RankingMetricsDto {
  seasonParticipantId: string;
  rank: number;
  provisionalTier: string | null;
  finalTier: string | null;
  returnRate: RateString;
  percentile: PercentString;
  totalAssetKrw: MoneyString;
  maxDrawdown: PercentString;
  totalFillCount: number;
  reachedReturnAt: IsoDateTimeString | null;
  capturedAt: IsoDateTimeString;
}

export interface RankingItemDto extends RankingMetricsDto {
  userId: string;
  nickname: string;
  profileImageUrl: string | null;
}

export type MyRankingDto =
  | (RankingMetricsDto & { state: 'available'; rankingDate: string })
  | { state: 'not_joined' | 'unavailable'; reason: string; message: string };

export interface RankingsResponseDto {
  state: 'available' | 'unavailable';
  season: {
    id: string;
    name: string;
    status: SeasonStatus;
    startAt: IsoDateTimeString;
    endAt: IsoDateTimeString;
  } | null;
  rankType: RankingRankType;
  rankingDate: string | null;
  capturedAt: IsoDateTimeString | null;
  pagination: OffsetPagination;
  rankings: RankingItemDto[];
  myRanking: MyRankingDto;
  reason?: string;
  message?: string;
}

export interface UserSeasonSummaryDto {
  state: 'available' | 'not_joined' | 'unavailable';
  user: {
    id: string;
    nickname: string;
  };
  season: {
    id: string;
    status: SeasonStatus;
    rank: number | null;
    provisionalTier: string | null;
    finalTier: string | null;
    returnRate: RateString | null;
    percentile: PercentString | null;
    totalAssetKrw: MoneyString | null;
    totalFillCount: number;
  } | null;
  allocation: {
    cashKrwValue: MoneyString;
    domesticStockValueKrw: MoneyString;
    usStockValueKrw: MoneyString;
    cryptoValueKrw: MoneyString;
  };
  topPositions: Array<{
    assetId: string;
    symbol: string;
    name: string;
    weight: string;
  }>;
  reason?: string;
  message?: string;
}

export interface GetRankingsParams {
  scope: RankingScope;
  /**
   * The season the leaderboard is about. Omitted means "whatever season is
   * current", which is the public ranking tab's question. A screen that is
   * about a SELECTED ACCOUNT must name the account's own season instead
   * (작업 11 §10.1) — otherwise a user looking at last season's account is
   * shown this season's rank beside last season's name.
   */
  seasonId?: string | null;
  rankType?: RankingRankType;
  limit?: number;
  offset?: number;
  rankingDate?: string | null;
  capturedAt?: string | null;
}

export function getRankingTier(
  item: Pick<RankingMetricsDto, 'provisionalTier' | 'finalTier'> | null | undefined,
  rankType?: RankingRankType,
) {
  if (rankType === 'final') {
    return item?.finalTier ?? '-';
  }

  return item?.provisionalTier ?? item?.finalTier ?? '-';
}

export async function getRankings(params: GetRankingsParams): Promise<RankingsResponseDto> {
  const limit = params.limit ?? (params.scope === 'top10' ? 10 : 50);
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();

  searchParams.set('scope', params.scope);
  if (params.seasonId) searchParams.set('seasonId', params.seasonId);
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));
  if (params.rankType) searchParams.set('rankType', params.rankType);
  if (params.rankingDate) searchParams.set('rankingDate', params.rankingDate);
  if (params.capturedAt) searchParams.set('capturedAt', params.capturedAt);

  const response = await apiClient.get<
    ApiSuccessResponse<RankingsResponseDto>
  >(`/ranking?${searchParams.toString()}`);

  return response.data.data;
}

export async function getUserSeasonSummary(userId: string) {
  const response = await apiClient.get<
    ApiSuccessResponse<UserSeasonSummaryDto>
  >(`/users/${userId}/season-summary`);

  return response.data.data;
}
