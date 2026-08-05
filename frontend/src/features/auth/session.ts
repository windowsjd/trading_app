import { clearTokens } from '../../services/storage/tokenStorage';
import { resetSessionExpiryNotice } from '../../services/api/sessionExpiry';
import { clearSelectedAccountId } from '../tradingAccount/selectionStorage';
import {
  clearSessionCache,
  seedSessionCache,
  type SessionQueryClient,
} from './sessionCache.ts';
import type { AuthUserDto } from './api';

/**
 * The session boundary — the ONE place a user's session is installed and torn
 * down (작업 10 §A-7 · §A-8).
 *
 * This module is the thin composition of two halves: the token/AsyncStorage
 * teardown here, and the query-cache teardown in `sessionCache.ts`, which
 * carries the reasoning about why the cache is CLEARED rather than invalidated
 * and why it is cleared wholesale rather than by key list.
 */

export type { SessionQueryClient };

/** Called after a successful login/signup, BEFORE navigating into the app. */
export async function beginSession(
  queryClient: SessionQueryClient,
  user: AuthUserDto,
) {
  await seedSessionCache(queryClient, user);
  // The expiry notice is one-shot per session; re-arm it for this one.
  resetSessionExpiryNotice();
}

/**
 * Called on explicit logout AND on an unrecoverable session expiry.
 *
 * Local teardown always completes even when the server logout call failed: a
 * user who pressed 로그아웃 on a shared device must not stay logged in because
 * the network was down. The caller does the server revoke (best effort) and
 * then calls this.
 *
 * `userId` is omitted on expiry, where `me` is already gone. The stored account
 * SELECTION is then left in place on purpose — it is an opaque pointer under a
 * per-user key, and keeping it returns the same user to the same account when
 * they sign back in.
 */
export async function endSession(
  queryClient: SessionQueryClient,
  userId?: string | null,
) {
  // The cache goes FIRST, synchronously, before any await (작업 12 §4). It used
  // to wait behind the AsyncStorage round-trip, which left a window in which
  // the tokens were gone but the previous session's balances were still
  // readable — and a screen rendering during that window paints them.
  clearSessionCache(queryClient);

  await clearTokens();

  if (userId) {
    await clearSelectedAccountId(userId);
  }
}
