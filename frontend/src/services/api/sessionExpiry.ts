import {
  canUseSessionCredentials,
  getSessionGeneration,
  invalidateSession,
  isCurrentSession,
} from './sessionOwnership.ts';

// One callback, with an owned pending notice for expiry before React mounts.
// Invalidation happens synchronously, before the handler can perform storage I/O.
type SessionExpiredHandler = (endedGeneration: number) => void;
let handler: SessionExpiredHandler | null = null;
let pending: number | null = null;

function deliverPending() {
  if (!handler || pending === null) return;
  const owner = pending;
  pending = null;
  if (isCurrentSession(owner)) handler(owner);
}

export function setSessionExpiredHandler(next: SessionExpiredHandler | null) {
  handler = next;
  deliverPending();
}

export function notifySessionExpired(owner = getSessionGeneration()) {
  // An ended generation cannot notify again, even across handler registration.
  if (!canUseSessionCredentials(owner)) return;
  pending = invalidateSession(owner);
  deliverPending();
}

export function resetSessionExpiryNotice() {
  pending = null;
}
