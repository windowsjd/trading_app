import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type {
  CurrentSeasonDto,
  JoinSeasonDto,
} from '../../models/dto/season';

export type {
  CurrentSeasonDto,
  JoinSeasonDto,
  SeasonEffectiveMode,
  SeasonStatus,
} from '../../models/dto/season';

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
