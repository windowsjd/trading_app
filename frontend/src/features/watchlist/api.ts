import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { AssetType } from '../market/api';

export interface WatchlistItem {
  assetId: string;
  name: string;
  symbol: string;
  market: string;
  assetType: AssetType;
  isActive: boolean;
  createdAt: string;
}

export async function getWatchlist(generation: number, signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<{ items: WatchlistItem[] }>>(
    '/watchlist',
    { signal, _sessionGeneration: generation },
  );
  return response.data.data.items;
}

export async function setWatchlist(assetId: string, registered: boolean, generation: number) {
  const url = `/watchlist/${encodeURIComponent(assetId)}`;
  const config = { _sessionGeneration: generation };
  if (registered) await apiClient.put(url, undefined, config);
  else await apiClient.delete(url, config);
}
