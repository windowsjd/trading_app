/**
 * The ORDER an expired session is torn down in (작업 12 §4).
 *
 * The three steps are not interchangeable, and the bridge used to run them
 * concurrently:
 *
 *     void endSession(queryClient);   // async: token + storage, then cache
 *     resetToLoginFromRef();          // immediately
 *
 * `endSession` awaited AsyncStorage before it touched the query cache, so
 * between the navigation reset and the storage round-trip there was a window in
 * which the previous session's portfolio, balances and orders were still
 * readable from the cache — and any screen still mounted during the transition
 * could paint them. Small, but it is exactly the window this whole mechanism
 * exists to close.
 *
 * The order below is fixed:
 *
 *   1. CLEAR THE CACHE, synchronously, before the first `await`. Nothing can
 *      run between "the session is over" and "the data is gone".
 *   2. Clear tokens and per-user storage. This is I/O and may fail.
 *   3. Reset navigation to Login — LAST, and in a `finally`, because a user
 *      whose AsyncStorage write failed must still end up on the login screen
 *      rather than inside an app that can no longer authenticate.
 *
 * Kept dependency-injected so the order itself is testable without React
 * Native's storage or a navigation container.
 */

export type SessionExpiryTeardownSteps = {
  /** Must be synchronous: the cache has to be gone before any await. */
  clearCache: () => void;
  /** Tokens and any per-user storage. May reject. */
  clearCredentials: () => Promise<void> | void;
  /** Navigation reset to the login screen. */
  resetToLogin: () => void;
};

export async function runSessionExpiryTeardown(
  steps: SessionExpiryTeardownSteps,
): Promise<void> {
  steps.clearCache();

  try {
    await steps.clearCredentials();
  } finally {
    steps.resetToLogin();
  }
}
