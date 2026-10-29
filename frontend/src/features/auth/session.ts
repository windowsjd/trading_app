import {
  clearTokens,
  readRefreshTokenForCleanup,
  runSessionStorage,
  saveTokens,
} from '../../services/storage/tokenStorage';
import { resetSessionExpiryNotice } from '../../services/api/sessionExpiry';
import {
  activateSession,
  assertCurrentSession,
  getSessionGeneration,
  invalidateSession,
  isCurrentSession,
  reportSessionStorageFailure,
  startSessionInstall,
} from '../../services/api/sessionOwnership';
import { clearSelectedAccountId } from '../tradingAccount/selectionStorage';
import {
  clearSessionCache,
  seedSessionCache,
  type SessionQueryClient,
} from './sessionCache.ts';
import { runSessionExpiryTeardown } from './sessionTeardown.ts';
import { setGuestBrowsing } from './guestBrowsing.ts';
import type { AuthTokensDto, AuthUserDto, LoginResponseDto } from './api';

export type { SessionQueryClient };

/** Reserve ownership BEFORE token I/O. Cache activation requires a complete
 * credential install; an unsuccessful/partial multiSet never installs `me`. */
export async function beginSession(
  queryClient: SessionQueryClient,
  user: AuthUserDto,
  tokens: AuthTokensDto,
  expected = getSessionGeneration(),
) {
  const owner = startSessionInstall(expected);
  // An authenticated session never coexists with guest browsing.
  setGuestBrowsing(false);
  resetSessionExpiryNotice();
  clearSessionCache(queryClient);
  try {
    await saveTokens(tokens.accessToken, tokens.refreshToken, owner);
  } catch (error) {
    if (isCurrentSession(owner)) {
      reportSessionStorageFailure('install tokens');
      await endSession(queryClient, undefined, { generation: owner });
    }
    throw error;
  }
  assertCurrentSession(owner);
  activateSession(owner);
  await seedSessionCache(queryClient, user);
  assertCurrentSession(owner);
  return owner;
}

/** Captures the login/signup request's owner as well as the install's owner. */
export async function authenticateSession(
  queryClient: SessionQueryClient,
  authenticate: () => Promise<LoginResponseDto>,
) {
  // Explicit auth owns a new attempt before HTTP starts, so a restoring /me
  // response cannot expire this attempt while its login/signup is in flight.
  const expected = startSessionInstall(getSessionGeneration());
  resetSessionExpiryNotice();
  clearSessionCache(queryClient);
  try {
    const result = await authenticate();
    assertCurrentSession(expected);
    const generation =
      result.user.status === 'active'
        ? await beginSession(queryClient, result.user, result.tokens, expected)
        : expected;
    return { ...result, generation };
  } catch (error) {
    if (isCurrentSession(expected)) {
      await endSession(queryClient, undefined, { generation: expected });
    }
    throw error;
  }
}

/**
 * 「로그인 없이 둘러보기」: the main tabs with no session at all (2026-10-30).
 *
 * The pre-login session — a cold start's restoring phase, or one a logout or
 * an expiry already ended — is ended FIRST and awaited. A request still in
 * flight from it (the account provider's /me at cold start) then can neither
 * refresh nor expire into a reset to login, a teardown already running
 * finishes its own navigation before the tabs open, and no request in
 * browsing can attach or refresh credentials; guest market reads go out as
 * public requests (`guestReadConfig`). The cache is cleared even when the
 * session had already ended, so nothing of a previous user survives.
 *
 * Creates nothing: no user, account, wallet, token or server session.
 * Resolves with the guest's generation; the caller opens the tabs only while
 * it is still current. A sign-in begun meanwhile owns the session and the
 * next screen: browsing then starts nothing at all.
 */
export async function beginGuestBrowsing(queryClient: SessionQueryClient) {
  const ending = endSession(queryClient);
  // The ended generation browsing belongs to (endSession invalidates first).
  const owner = getSessionGeneration();
  await ending;
  if (!isCurrentSession(owner)) return owner;
  clearSessionCache(queryClient);
  setGuestBrowsing(true);
  return owner;
}

type EndSessionOptions = {
  generation?: number;
  resetToLogin?: () => void;
  revoke?: (refreshToken: string | null) => Promise<unknown>;
};
export type SessionCleanupResult = {
  tokensRemoved: boolean;
  selectionRemoved: boolean | null;
};
let teardown: { generation: number; promise: Promise<SessionCleanupResult> } | null =
  null;

/** Runtime invalidation and cache clear precede all storage/network awaits.
 * Expiry passes its already-invalidated owner and omits per-user cleanup. */
export function endSession(
  queryClient: SessionQueryClient,
  userId?: string | null,
  options: EndSessionOptions = {},
): Promise<SessionCleanupResult> {
  const owner = invalidateSession(options.generation ?? getSessionGeneration());
  if (owner === null)
    return Promise.resolve({ tokensRemoved: false, selectionRemoved: null });
  if (teardown?.generation === owner) return teardown.promise;
  const result: SessionCleanupResult = { tokensRemoved: false, selectionRemoved: null };
  const promise = runSessionExpiryTeardown({
    isCurrent: () => isCurrentSession(owner),
    clearCache: () => clearSessionCache(queryClient),
    clearCredentials: async () => {
      if (options.revoke) {
        try {
          const token = await readRefreshTokenForCleanup(owner);
          // Revoke is independent of local completion and never uses B's token.
          if (isCurrentSession(owner)) void options.revoke(token).catch(() => undefined);
        } catch {
          if (isCurrentSession(owner))
            reportSessionStorageFailure('read refresh token for logout');
        }
      }
      try {
        await clearTokens(owner);
        result.tokensRemoved = true;
      } catch {
        if (isCurrentSession(owner)) reportSessionStorageFailure('remove tokens');
      }
      if (userId && isCurrentSession(owner)) {
        try {
          result.selectionRemoved = await runSessionStorage(owner, () =>
            clearSelectedAccountId(userId),
          );
        } catch {
          result.selectionRemoved = false;
          if (isCurrentSession(owner))
            reportSessionStorageFailure('remove account selection');
        }
      }
    },
    resetToLogin: () => options.resetToLogin?.(),
  }).then(() => result);
  teardown = { generation: owner, promise };
  return promise;
}
