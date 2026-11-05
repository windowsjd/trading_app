import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import { parseAppReleaseManifest } from './appUpdate.ts';

/** Public and read-only: the store-published latest version per platform. */
export async function getAppRelease(signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<unknown>>('/app-release', { signal });
  return parseAppReleaseManifest(response.data.data);
}
