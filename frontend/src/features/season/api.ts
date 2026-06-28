import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  RateString,
} from '../../models/dto/common';
import type {
  CurrentSeasonDto,
  JoinSeasonDto,
  SeasonStatus,
} from '../../models/dto/season';

export type {
  CurrentSeasonDto,
  JoinSeasonDto,
  SeasonEffectiveMode,
  SeasonStatus,
} from '../../models/dto/season';

export interface SeasonListItemDto {
  id: string;
  name: string;
  status: SeasonStatus | string;
  effectiveStatus?: string;
  effectiveMode?: string;
  startAt: IsoDateTimeString;
  endAt: IsoDateTimeString;
  initialCapitalKrw?: MoneyString;
  tradeFeeRate?: RateString;
  fxFeeRate?: RateString;
  joined?: boolean;
  joinedAt?: IsoDateTimeString | null;
}

export interface SeasonsResponseDto {
  state?: 'available' | 'empty' | 'unavailable' | 'error';
  seasons: SeasonListItemDto[];
  pagination: OffsetPagination;
}

export interface GetSeasonsParams {
  status?: SeasonStatus | string;
  limit?: number;
  offset?: number;
}

export async function getCurrentSeason() {
  const response = await apiClient.get<ApiSuccessResponse<CurrentSeasonDto>>(
    '/seasons/current',
  );

  return response.data.data;
}

export async function getSeasons(params: GetSeasonsParams = {}) {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();

  if (params.status) searchParams.set('status', params.status);
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  const response = await apiClient.get<
    ApiSuccessResponse<
      Omit<SeasonsResponseDto, 'seasons'> & {
        seasons?: SeasonListItemDto[];
        items?: SeasonListItemDto[];
      }
    >
  >(`/seasons?${searchParams.toString()}`);

  const data = response.data.data;

  return {
    ...data,
    seasons: data.seasons ?? data.items ?? [],
  };
}

export async function joinSeason(seasonId: string) {
  const response = await apiClient.post<ApiSuccessResponse<JoinSeasonDto>>(
    `/seasons/${seasonId}/join`,
  );

  return response.data.data;
}
