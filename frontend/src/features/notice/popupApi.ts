import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import { parsePopupNotices } from './popupNotices.ts';

/** The signed-in member's unconfirmed popup notices (server-side state, any device). */
export async function getPopupNotices(signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<{ notices: unknown }>>('/notices/popup', { signal });
  return parsePopupNotices(response.data?.data?.notices);
}

/** Confirmed or closed: recorded once per member and notice (the server ignores repeats). */
export async function acknowledgeNotice(noticeId: string) {
  await apiClient.post(`/notices/${encodeURIComponent(noticeId)}/acknowledgement`);
}
