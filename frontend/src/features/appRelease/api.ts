import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import { parseAppReleaseManifest } from './appUpdate.ts';

/**
 * Public and read-only: the store-published latest version per platform. Sent
 * without the session's credentials (`skipSessionAuth`), like a guest's public
 * read: a signed-out visitor can read it too, and this read never attaches,
 * refreshes or expires a session — before 2026-11-11 a signed-out app
 * (session ended) threw before sending, so guests never heard of an update.
 */
export async function getAppRelease(signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<unknown>>('/app-release', { signal, skipSessionAuth: true });
  return parseAppReleaseManifest(response.data.data);
}
