import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';

export type SeasonStatus = 'upcoming' | 'active' | 'ended' | 'settled';

export interface CurrentSeasonDto {
  id: string;
  name: string;
  status: SeasonStatus;
  startAt: string;
  endAt: string;
  initialCapitalKrw: string;
  tradeFeeRate: string;
  fxFeeRate: string;
  joined: boolean;
  joinedAt: string | null;
}

export interface JoinSeasonDto {
  seasonParticipantId: string;
  seasonId: string;
  joinedAt: string;
  wallets: {
    KRW: string;
    USD: string;
  };
}

export async function getCurrentSeason() {
  const response = await apiClient.get<ApiSuccessResponse<CurrentSeasonDto>>(
    '/seasons/current',
  );

  return response.data.data;
}

export async function joinSeason(seasonId: string) {
  const response = await apiClient.post<ApiSuccessResponse<JoinSeasonDto>>(
    `/seasons/${seasonId}/join`,
  );

  return response.data.data;
}