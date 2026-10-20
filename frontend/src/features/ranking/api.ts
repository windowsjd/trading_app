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
import type { SpotHoldingDisplay } from '../position/assetDisplay';
import type { FuturesHolding } from '../futures/api';

export type RankingScope = 'all' | 'friends' | 'top10';
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

/**
 * One fully closed trade of a friend, as the server aggregates it: a Spot
 * holding closed now (매수 금액 = every buy, fee included) or one closed
 * Futures lifetime (진입 증거금 by the margin policy). 실현 손익 is confirmed
 * and includes fees; 수익률 is null when its basis is not above zero.
 */
export type FriendCompletedTrade =
  | {
      kind: 'spot'; assetId: string; symbol: string; name: string; market: string; assetType: string;
      currencyCode: 'KRW' | 'USD'; buyAmount: MoneyString; realizedPnl: MoneyString; returnRate: PercentString | null;
    }
  | {
      kind: 'futures'; assetId: string; symbol: string; name: string; market: string; direction: 'long' | 'short';
      currencyCode: 'USD'; entryMargin: MoneyString; realizedPnl: MoneyString; returnRate: PercentString | null;
    };

export interface UserSeasonSummaryDto {
  state: 'available' | 'not_joined' | 'unavailable';
  user: { id: string; nickname: string; profileImageUrl: string | null };
  season: {
    id: string;
    name: string;
    status: SeasonStatus;
    rank: number | null;
    provisionalTier: string | null;
    finalTier: string | null;
    returnRate: RateString | null;
    percentile: PercentString | null;
    totalAssetKrw: MoneyString | null;
    maxDrawdown: PercentString | null;
    totalFillCount: number;
  } | null;
  portfolioAccess: 'available' | 'private' | 'not_friend' | 'unavailable';
  portfolioReason?: string;
  portfolio: {
    valuationState: 'available' | 'unavailable';
    allocation: {
      cashKrwValue: MoneyString;
      domesticStockValueKrw: MoneyString;
      usStockValueKrw: MoneyString;
      cryptoValueKrw: MoneyString;
    } | null;
    holdings: Array<SpotHoldingDisplay & {
      assetId: string;
      symbol: string;
      name: string;
      assetType: string;
      weight: PercentString | null;
    }>;
    futures: { evaluatedAt: string; positions: FuturesHolding[] };
    history: Array<{
      date: string;
      totalAssetKrw: MoneyString;
      returnRate: PercentString;
    }>;
    /** 거래 완료 종목 (backend docs/friends-api-contract.md); absent from a server before 2026-10-20. */
    completedTrades?: { items: FriendCompletedTrade[]; hasMore: boolean };
  } | null;
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
  /**
   * `me` (scope all only): the page starts at my own row, wherever the server
   * finds it in this set; `offset` is ignored and `pagination.offset` says
   * where the page starts. Without a row of mine it starts at the top.
   */
  anchor?: 'me';
}

export function getRankingTier(
  item:
    | Pick<RankingMetricsDto, 'provisionalTier' | 'finalTier'>
    | null
    | undefined,
  rankType?: RankingRankType,
) {
  if (rankType === 'final') {
    return item?.finalTier ?? '-';
  }

  return item?.provisionalTier ?? item?.finalTier ?? '-';
}

/**
 * A window of the whole (`all`) leaderboard of one known daily set: the 순위
 * 안내 slot reads single rows by rank this way. `capturedAt` pins the set;
 * without it the latest set of `rankingDate` is read.
 */
export interface GetRankingSliceParams {
  seasonId: string;
  rankType: RankingRankType;
  rankingDate: string;
  capturedAt?: string | null;
  limit: number;
  offset: number;
}

export async function getRankings(
  params: GetRankingsParams,
): Promise<RankingsResponseDto> {
  return requestRankings(params);
}

/**
 * Same endpoint as getRankings, but its own entry point: the ranking tab's
 * publication and list reads stay countable apart from these row lookups.
 */
export async function getRankingSlice(
  params: GetRankingSliceParams,
): Promise<RankingsResponseDto> {
  return requestRankings({ ...params, scope: 'all' });
}

async function requestRankings(
  params: GetRankingsParams,
): Promise<RankingsResponseDto> {
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
  if (params.anchor) searchParams.set('anchor', params.anchor);

  const response = await apiClient.get<ApiSuccessResponse<RankingsResponseDto>>(
    `/ranking?${searchParams.toString()}`,
  );

  return response.data.data;
}

export async function getUserSeasonSummary(
  userId: string,
  signal?: AbortSignal,
) {
  const response = await apiClient.get<
    ApiSuccessResponse<UserSeasonSummaryDto>
  >(`/users/${encodeURIComponent(userId)}/season-summary`, { signal });

  const data = response.data.data;
  if (data.user.id !== userId) throw new Error('사용자 포트폴리오 응답을 확인할 수 없습니다.');
  return data.portfolioAccess === 'available' ? data : { ...data, portfolio: null };
}
