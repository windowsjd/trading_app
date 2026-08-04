/**
 * The one seam between "the refresh token is dead" and "tear the session down"
 * (작업 10 §A-8).
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

export function setSessionExpiredHandler(next: SessionExpiredHandler | null) {
  handler = next;
}

export function notifySessionExpired() {
  if (notified) return;

  notified = true;
  handler?.();
}

/** Called when a new session begins, so the next expiry can fire again. */
export function resetSessionExpiryNotice() {
  notified = false;
}
