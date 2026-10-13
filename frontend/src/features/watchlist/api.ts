import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse, IsoDateTimeString } from '../../models/dto/common';
import type { AssetType, AssetsResponseDto } from '../market/api';

/** One watched asset, identity read from the server's asset row. */
export interface WatchlistItemDto {
  assetId: string;
  symbol: string;
  name: string;
  market: string;
  assetType: AssetType;
  /** False once the asset was deactivated after it was added. */
  isActive: boolean;
  addedAt: IsoDateTimeString;
}

/** Every item of the caller, newest first; `limit` is the server's cap. */
export interface WatchlistDto {
  items: WatchlistItemDto[];
  limit: number;
}

/** Same rows and price errors as the market list, in watchlist order. */
export type WatchlistAssetsDto = Pick<AssetsResponseDto, 'state' | 'assets' | 'priceErrors'>;

export interface WatchlistAddResultDto {
  item: WatchlistItemDto;
  /** False when the asset was already watched (its addedAt is kept). */
  created: boolean;
}

export interface WatchlistRemoveResultDto {
  assetId: string;
  /** False when the asset was not watched. */
  removed: boolean;
}

const itemPath = (assetId: string) => `/watchlist/${encodeURIComponent(assetId)}`;

export async function getWatchlist(signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<WatchlistDto>>('/watchlist', { signal });
  return response.data.data;
}

export async function getWatchlistAssets(assetType: AssetType, signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<WatchlistAssetsDto>>(
    `/watchlist/assets?assetType=${assetType}`,
    { signal },
  );
  return response.data.data;
}

/** Target state "watched": repeating it is a success, never a toggle. */
export async function addToWatchlist(assetId: string) {
  const response = await apiClient.put<ApiSuccessResponse<WatchlistAddResultDto>>(itemPath(assetId));
  return response.data.data;
}

/** Target state "not watched": an absent item is a success. */
export async function removeFromWatchlist(assetId: string) {
  const response = await apiClient.delete<ApiSuccessResponse<WatchlistRemoveResultDto>>(itemPath(assetId));
  return response.data.data;
}
