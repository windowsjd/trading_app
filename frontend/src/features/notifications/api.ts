import axios from 'axios';
import { apiClient } from '../../services/api/client';
import { API_BASE_URL } from '../../constants/env';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { NotificationPreferences } from './types';

export async function getNotificationPreferences(signal?: AbortSignal) {
  const response = await apiClient.get<
    ApiSuccessResponse<{ preferences: NotificationPreferences }>
  >('/notifications/preferences', { signal });
  return response.data.data.preferences;
}

/** Answers with the committed switches, never an optimistic copy. */
export async function updateNotificationPreferences(patch: Partial<NotificationPreferences>) {
  const response = await apiClient.patch<
    ApiSuccessResponse<{ preferences: NotificationPreferences }>
  >('/notifications/preferences', patch);
  return response.data.data.preferences;
}

/** Ties this device's push token to the signed-in user. */
export async function registerPushDevice(token: string, platform: 'ios' | 'android') {
  await apiClient.put('/notifications/devices', { token, platform });
}

/**
 * Drops this device's registration. The token itself is the proof, like the
 * refresh-token logout, so this works after sign-out and outside any session
 * generation (a teardown in progress must not cancel it).
 */
export async function releasePushDevice(token: string) {
  await axios.post(`${API_BASE_URL}/notifications/devices/release`, { token }, { timeout: 10000 });
}

export type ImportantNoticeSection = { heading: string; paragraphs: string[] };
export type ImportantNoticeDto = {
  id: string;
  title: string;
  summary: string;
  sections: ImportantNoticeSection[];
  publishedAt: string | null;
};

/** Notices an operator published as important (newest first). */
export async function getImportantNotices(signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<{ notices: ImportantNoticeDto[] }>>(
    '/notices',
    { signal },
  );
  return response.data.data.notices;
}
