import { getApiErrorInfo } from '../../services/api/errorMapper.ts';

/** Server-side receipt of a confirmed 회원탈퇴 (backend docs/account-deletion-contract.md). */
export type MembershipDeletionReceipt = {
  /** `cleanup_pending`: the account and every record are already deleted;
   * only the profile photo file is still being removed. */
  status: 'cleanup_pending' | 'completed';
  deletedAt: string;
  completedAt: string | null;
};

/**
 * Refusals the server answers before it writes anything. They are final for
 * this attempt (the account is unchanged); trying again needs the user.
 * `ACCOUNT_DELETION_FAILED` means the deletion transaction rolled back.
 */
const REFUSALS = new Set([
  'ACCOUNT_DELETION_PASSWORD_MISMATCH',
  'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
  'ACCOUNT_DELETION_REQUEST_KEY_INVALID',
  'ACCOUNT_DELETION_ROLE_RESTRICTED',
  'ACCOUNT_DELETION_REQUIRES_SUPPORT',
  'ACCOUNT_DELETION_FAILED',
  'USER_NOT_ACTIVE',
  'EMAIL_RATE_LIMITED',
]);

export type MembershipDeletionOutcome =
  | { kind: 'deleted'; receipt: MembershipDeletionReceipt }
  | { kind: 'refused'; error: unknown; code: string }
  /** The server holds no receipt for this request: nothing was deleted. */
  | { kind: 'not_deleted'; error: unknown }
  /** Neither the request nor the status check gave an answer. */
  | { kind: 'unknown'; error: unknown };

/**
 * The deletion's outcome comes from the server, never from the request's
 * success alone. A lost response, a timeout, a proxy error, a superseded
 * session or a 401 (the account may already be gone) are resolved by the
 * receipt stored under this attempt's request key.
 */
export async function settleMembershipDeletion(
  remove: () => Promise<MembershipDeletionReceipt>,
  lookup: () => Promise<MembershipDeletionReceipt | null>,
): Promise<MembershipDeletionOutcome> {
  try {
    return { kind: 'deleted', receipt: await remove() };
  } catch (error) {
    const info = getApiErrorInfo(error);
    if (info.hasResponse && info.serverCode && REFUSALS.has(info.serverCode))
      return { kind: 'refused', error, code: info.serverCode };
    return confirmMembershipDeletion(lookup, error);
  }
}

export async function confirmMembershipDeletion(
  lookup: () => Promise<MembershipDeletionReceipt | null>,
  error: unknown,
): Promise<MembershipDeletionOutcome> {
  try {
    const receipt = await lookup();
    return receipt
      ? { kind: 'deleted', receipt }
      : { kind: 'not_deleted', error };
  } catch (lookupError) {
    return { kind: 'unknown', error: lookupError };
  }
}

type RandomSource = {
  crypto?: { randomUUID?: () => string };
  /** Installed by expo-modules-core on native (secure platform UUID). */
  expo?: { uuidv4?: () => string };
};

function secureUuid(source: RandomSource): string | undefined {
  return source.crypto?.randomUUID?.() ?? source.expo?.uuidv4?.();
}

/**
 * The request key that names one confirmation attempt (reused by its retries)
 * and is the only handle to the server-side status. Two platform UUIDs give
 * 244 random bits. It is held in memory only.
 */
export function createMembershipDeletionKey(
  source: RandomSource = globalThis,
): string {
  const first = secureUuid(source);
  const second = secureUuid(source);
  if (first && second) return `${first}${second}`.replace(/-/g, '');
  // No platform generator: the key still stays unique; it only guards the
  // status of this deletion, which carries no personal data.
  let fallback = Date.now().toString(36);
  while (fallback.length < 48) fallback += Math.random().toString(36).slice(2);
  return fallback;
}

/** The confirmed attempt's key, kept in memory for 결과 확인 on the result
 * screen after the session is gone (never persisted). */
let lastRequestKey: string | null = null;
export function rememberMembershipDeletion(requestKey: string) {
  lastRequestKey = requestKey;
}
export function membershipDeletionRequestKey() {
  return lastRequestKey;
}
export function forgetMembershipDeletion() {
  lastRequestKey = null;
}
