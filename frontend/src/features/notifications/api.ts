import axios from 'axios';
import { apiClient } from '../../services/api/client';
import { API_BASE_URL } from '../../constants/env';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { NotificationPreferences } from './types';
import { parseOrderFailure, type OrderFailureKind } from './orderFailure';

export class OrderFailureResponseError extends Error {
  constructor() {
    super('주문 결과를 확인할 수 없습니다.');
    this.name = 'OrderFailureResponseError';
  }
}

/** The stored result of one failure row in the caller's own account; a
 * 404 means it is not (or no longer) this account's. Read-only. */
export async function getOrderFailure(
  accountId: string,
  kind: OrderFailureKind,
  failureId: string,
  signal?: AbortSignal,
) {
  const response = await apiClient.get<ApiSuccessResponse<{ failure: unknown }>>(
    `/trading-accounts/${encodeURIComponent(accountId)}/order-failures/${kind}/${encodeURIComponent(failureId)}`,
    { signal },
  );
  const failure = parseOrderFailure(response.data?.data?.failure);
  if (!failure || failure.tradingAccountId !== accountId || failure.kind !== kind || failure.id !== failureId)
    throw new OrderFailureResponseError();
  return failure;
}

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
