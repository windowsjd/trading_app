import { apiClient } from '../../services/api/client';
import { getApiErrorCode } from '../../services/api/errorMapper';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { MembershipDeletionReceipt } from './membershipDeletionFlow';

type DeletionResponse = ApiSuccessResponse<{
  deletion: MembershipDeletionReceipt;
}>;

/** 본인 확인: verifies the password and eligibility; writes nothing. */
export async function checkMembershipPassword(password: string) {
  await apiClient.post('/me/account-deletion/password-check', { password });
}

/** The confirmed deletion. Generous timeout: the result is confirmed by the
 * receipt anyway when the response is lost. */
export async function deleteMembership(input: {
  password: string;
  requestKey: string;
}) {
  const response = await apiClient.post<DeletionResponse>(
    '/me/account-deletion',
    { password: input.password, requestKey: input.requestKey, confirm: true },
    { timeout: 30000 },
  );
  return response.data.data.deletion;
}

/** Public: readable after the session (and the account) are gone. */
export async function getMembershipDeletionStatus(requestKey: string) {
  try {
    const response = await apiClient.post<DeletionResponse>(
      '/auth/account-deletion/status',
      { requestKey },
      { skipSessionAuth: true },
    );
    return response.data.data.deletion;
  } catch (error) {
    if (getApiErrorCode(error) === 'ACCOUNT_DELETION_NOT_FOUND') return null;
    throw error;
  }
}
