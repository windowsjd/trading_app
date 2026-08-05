import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  notifySessionExpired,
  resetSessionExpiryNotice,
  setSessionExpiredHandler,
} from './sessionExpiry.ts';

/**
 * Module state is global by design (one axios singleton, one app root), so
 * every test starts from a known state rather than a leftover one.
 */
beforeEach(() => {
  setSessionExpiredHandler(null);
  resetSessionExpiryNotice();
});

describe('session expiry notice', () => {
  it('runs a registered handler once, immediately', () => {
    let calls = 0;
    setSessionExpiredHandler(() => calls++);

    notifySessionExpired();

    assert.equal(calls, 1);
  });

  it('delivers an expiry that happened BEFORE the handler registered', () => {
    // Cold start: the restored refresh token is already dead, axios 401s while
    // the React tree is still mounting. This used to be dropped entirely.
    notifySessionExpired();

    let calls = 0;
    setSessionExpiredHandler(() => calls++);

    assert.equal(calls, 1, 'the pending expiry must reach the handler');
  });

  it('delivers a pending expiry exactly once, not on every re-registration', () => {
    notifySessionExpired();

    let calls = 0;
    const handler = () => calls++;
    setSessionExpiredHandler(handler);
    setSessionExpiredHandler(null);
    setSessionExpiredHandler(handler);

    assert.equal(calls, 1);
  });

  it('tears down ONCE for a burst of parallel 401s', () => {
    let calls = 0;
    setSessionExpiredHandler(() => calls++);

    // Five screens each had a request in flight against the same dead token.
    notifySessionExpired();
    notifySessionExpired();
    notifySessionExpired();
    notifySessionExpired();
    notifySessionExpired();

    assert.equal(calls, 1);
  });

  it('tears down once even when the burst straddles handler registration', () => {
    notifySessionExpired();
    notifySessionExpired();

    let calls = 0;
    setSessionExpiredHandler(() => calls++);
    notifySessionExpired();

    assert.equal(calls, 1);
  });

  it('does not re-enter when a handler notifies again while running', () => {
    let calls = 0;
    setSessionExpiredHandler(() => {
      calls++;
      // e.g. teardown itself issues a request that 401s.
      notifySessionExpired();
    });

    notifySessionExpired();

    assert.equal(calls, 1, 'no second navigation reset, no second teardown');
  });

  it('re-arms for the NEXT session after a new session begins', () => {
    let calls = 0;
    setSessionExpiredHandler(() => calls++);
    notifySessionExpired();
    assert.equal(calls, 1);

    resetSessionExpiryNotice();
    notifySessionExpired();

    assert.equal(calls, 2);
  });

  it('never delivers the previous session’s expiry into a new session', () => {
    // Expiry with no handler, then the user logs in again before the app root
    // re-registers. The remembered expiry belongs to the dead session and must
    // not tear down the fresh login.
    notifySessionExpired();
    resetSessionExpiryNotice();

    let calls = 0;
    setSessionExpiredHandler(() => calls++);

    assert.equal(calls, 0);
  });

  it('keeps remembering an expiry while no handler is registered', () => {
    setSessionExpiredHandler(null);
    notifySessionExpired();

    // The app root remounts later (e.g. after a navigation container reset).
    let calls = 0;
    setSessionExpiredHandler(() => calls++);

    assert.equal(calls, 1);
  });
});
