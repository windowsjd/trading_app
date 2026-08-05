/**
 * The one seam between "the refresh token is dead" and "tear the session down"
 * (작업 10 §A-8 · 작업 12 §4).
 *
 * The axios client is a module-level singleton created before any React tree
 * exists, so it cannot hold a QueryClient or a navigator. It needs to tell the
 * app exactly one thing, exactly once per expiry: the session is over.
 *
 * This is deliberately a SINGLE nullable callback, not an event bus, not an
 * emitter, not a subscription list. One producer (the 401 refresh path), one
 * consumer (the app root), no ordering, no unsubscribe bookkeeping, no
 * possibility of two handlers racing to clear the same cache.
 *
 * WHY IT MUST EXIST AT ALL
 * ------------------------
 * Before this, a failed refresh cleared the TOKENS and nothing else. The
 * screens kept rendering whatever was already in the query cache — a full
 * portfolio, wallet balances, open orders — for a session the server had
 * already stopped honouring. The data was real, but it belonged to a session
 * that no longer existed, and on a shared device the next person to pick up
 * the phone would still be looking at it.
 *
 * WHY THE EXPIRY IS *PENDING* RATHER THAN DROPPED
 * -----------------------------------------------
 * `notified` alone lost expiries. The axios singleton exists before the React
 * tree mounts, and the handler is installed in an effect — so a refresh that
 * fails during cold start (a restored session whose refresh token expired
 * overnight, which is the single most likely time for this to happen) set
 * `notified = true` against a null handler and the teardown NEVER ran. The user
 * landed on a normal-looking app whose every request 401s, with the previous
 * session's cache still on screen.
 *
 * So an expiry with no handler is REMEMBERED and delivered to the next handler
 * that registers — once. `notified` still guarantees at-most-once, so a burst
 * of parallel 401s from a dead refresh token produces exactly one teardown.
 */

type SessionExpiredHandler = () => void;

let handler: SessionExpiredHandler | null = null;
/**
 * A dead refresh token produces one failure per in-flight request. The
 * teardown must happen once, not once per request, or a burst of parallel
 * screens would each clear the cache and reset navigation on top of each
 * other.
 */
let notified = false;
/** An expiry that arrived before any handler was registered. */
let pending = false;

export function setSessionExpiredHandler(next: SessionExpiredHandler | null) {
  handler = next;

  // The expiry that happened before the app root mounted is delivered now —
  // and only now, because `pending` is cleared before the call. A handler that
  // unregisters and re-registers does not re-fire it.
  if (handler && pending) {
    pending = false;
    handler();
  }
}

export function notifySessionExpired() {
  if (notified) return;

  notified = true;

  if (!handler) {
    pending = true;
    return;
  }

  handler();
}

/**
 * Called when a new session begins, so the next expiry can fire again.
 *
 * Clears the pending flag too: a remembered expiry belongs to the session that
 * just ended, and delivering it into the session that just started would tear
 * down a perfectly valid login.
 */
export function resetSessionExpiryNotice() {
  notified = false;
  pending = false;
}
