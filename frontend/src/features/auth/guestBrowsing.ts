import { getApiErrorStatus } from '../../services/api/errorMapper.ts';

/**
 * 「로그인 없이 둘러보기」 (2026-10-30): a signed-out visitor in the main tabs.
 *
 * A navigation state, not a fourth investment mode and not an account: no
 * user, TradingAccount, wallet, token or server session is created, and
 * nothing is persisted — a restart opens the login screen again. Only the
 * login screen's explicit button starts it (`beginGuestBrowsing`); a failed
 * session restore or a network error never does, and an authenticated
 * session ends it.
 *
 * Read, not subscribed: it changes only while no main tab is mounted (entry
 * resets the root to the tabs, leaving resets it to the auth stack, and a
 * sign-in starts from the auth stack), so a mounted screen never sees it flip.
 */
let browsing = false;

export function isGuestBrowsing() {
  return browsing;
}

export function setGuestBrowsing(next: boolean) {
  browsing = next;
}

/**
 * A guest's account-free market read goes out as a public request: no
 * credentials attached, refreshed or expired (the API client's
 * `skipSessionAuth` path). Signed-in reads keep their usual config.
 */
export function guestReadConfig() {
  return browsing ? { skipSessionAuth: true } : undefined;
}

/**
 * The server answers a guest's read of data it does not serve to signed-out
 * visitors with 401: that is "sign in to see this", never a failure to retry.
 */
export function isGuestSignInRequired(error: unknown) {
  return browsing && getApiErrorStatus(error) === 401;
}

/** React Query retry for a guest's market read: one retry, none after a 401. */
export function retryGuestRead(failureCount: number, error: unknown) {
  return failureCount < 1 && !isGuestSignInRequired(error);
}
