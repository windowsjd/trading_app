import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isFxQuoteResponseCurrent,
  isFxResponseInScope,
  type FxQuoteRequestScope,
  type FxRequestScope,
} from './fxAccountScope.ts';

/**
 * These model the account-switch race directly: a request is issued in one
 * scope, the scope changes, and the response arrives late.
 */

const A: FxRequestScope = { accountId: 'acc-a', scopeEpoch: 0 };
const B: FxRequestScope = { accountId: 'acc-b', scopeEpoch: 1 };

function quoteScope(
  scope: FxRequestScope,
  overrides: Partial<Omit<FxQuoteRequestScope, keyof FxRequestScope>> = {},
): FxQuoteRequestScope {
  return {
    ...scope,
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '100000',
    ...overrides,
  };
}

describe('FX response account scope', () => {
  describe('isFxResponseInScope', () => {
    it('accepts a response for the account the screen is showing now', () => {
      assert.equal(isFxResponseInScope(A, A), true);
    });

    it("rejects account A's response after the user switched to account B", () => {
      // The exact stale-response case: the request was issued for A, the
      // screen is now B. Applying it would show A's numbers under B's heading.
      assert.equal(isFxResponseInScope(A, B), false);
    });

    it('rejects a response from BEFORE a switch even when the user switched back', () => {
      // A → B → A. The ids match again, but the screen was wiped in between,
      // so the in-flight quote describes something the user can no longer see.
      const backOnA: FxRequestScope = { accountId: 'acc-a', scopeEpoch: 2 };
      assert.equal(isFxResponseInScope(A, backOnA), false);
      assert.equal(isFxResponseInScope(backOnA, backOnA), true);
    });

    it('rejects everything while no account is selected', () => {
      const none: FxRequestScope = { accountId: '', scopeEpoch: 0 };
      assert.equal(isFxResponseInScope(A, none), false);
      assert.equal(isFxResponseInScope(none, A), false);
      assert.equal(isFxResponseInScope(none, none), false);
    });
  });

  describe('isFxQuoteResponseCurrent', () => {
    it('accepts a quote for the current account and the current inputs', () => {
      assert.equal(
        isFxQuoteResponseCurrent(quoteScope(A), quoteScope(A)),
        true,
      );
    });

    it("rejects account A's quote once the screen shows account B", () => {
      // Even when the amount happens to be identical — a coincidence of digits
      // must not let one account's quote render as another's.
      assert.equal(
        isFxQuoteResponseCurrent(quoteScope(A), quoteScope(B)),
        false,
      );
    });

    it('still rejects a superseded quote within the SAME account', () => {
      // The pre-existing latest-wins rule must survive the new scope check.
      assert.equal(
        isFxQuoteResponseCurrent(
          quoteScope(A, { sourceAmount: '100000' }),
          quoteScope(A, { sourceAmount: '250000' }),
        ),
        false,
      );
      assert.equal(
        isFxQuoteResponseCurrent(
          quoteScope(A, { fromCurrency: 'KRW', toCurrency: 'USD' }),
          quoteScope(A, { fromCurrency: 'USD', toCurrency: 'KRW' }),
        ),
        false,
      );
    });

    it('rejects a quote whose inputs match but whose account does not', () => {
      const sameInputsDifferentAccount = quoteScope({
        accountId: 'acc-b',
        scopeEpoch: 0,
      });
      assert.equal(
        isFxQuoteResponseCurrent(quoteScope(A), sameInputsDifferentAccount),
        false,
      );
    });
  });
});
