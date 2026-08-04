import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  assertAccountScope,
  isTradingAccountScopeMismatchError,
  TradingAccountScopeMismatchError,
} from './accountScope.ts';
import { classifyAccountError } from './integrityErrors.ts';

function silenceConsoleError() {
  const original = console.error;
  const calls: string[] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args.map(String).join(' '));
  };
  return {
    calls,
    restore: () => {
      console.error = original;
    },
  };
}

describe('assertAccountScope', () => {
  it('passes through a response that names the requested account', () => {
    const payload = { tradingAccountId: 'acc-1', wallets: [] };

    assert.equal(assertAccountScope('GET /x', 'acc-1', payload), payload);
  });

  it('passes through a response that carries NO account id', () => {
    // Order detail, create, cancel and the FX rows return the legacy shape with
    // no envelope. Treating absence as a mismatch would break every one of
    // them, and the path already named the account.
    const payload = { order: { id: 'o-1' } };

    assert.equal(assertAccountScope('GET /x', 'acc-1', payload), payload);
  });

  it('REFUSES a response that names a different account', () => {
    const silenced = silenceConsoleError();

    try {
      assert.throws(
        () =>
          assertAccountScope('GET /portfolio', 'acc-1', {
            tradingAccountId: 'acc-2',
            summary: { totalAssetKrw: '99999999' },
          }),
        TradingAccountScopeMismatchError,
      );
    } finally {
      silenced.restore();
    }
  });

  it('checks the nested row shape too (order / quote / execution / claim)', () => {
    const silenced = silenceConsoleError();

    try {
      assert.throws(
        () =>
          assertAccountScope('POST /orders', 'acc-1', {
            order: { id: 'o-1', tradingAccountId: 'acc-2' },
          }),
        TradingAccountScopeMismatchError,
      );
    } finally {
      silenced.restore();
    }
  });

  it('logs the endpoint and both ids — and NOT the payload', () => {
    const silenced = silenceConsoleError();

    try {
      assert.throws(() =>
        assertAccountScope('GET /trading-accounts/:accountId/wallets', 'acc-1', {
          tradingAccountId: 'acc-2',
          // A balance from someone else's account must never reach a log line.
          wallets: [{ currencyCode: 'KRW', balanceAmount: '123456789' }],
        }),
      );
    } finally {
      silenced.restore();
    }

    assert.equal(silenced.calls.length, 1);
    const logged = silenced.calls[0];
    assert.ok(logged.includes('/wallets'));
    assert.ok(logged.includes('acc-1'));
    assert.ok(logged.includes('acc-2'));
    assert.ok(
      !logged.includes('123456789'),
      'the other account’s balances must not be logged',
    );
    assert.ok(
      !logged.includes('currencyCode'),
      'no payload keys in the log line',
    );
    assert.ok(!logged.includes('balanceAmount'));
  });

  it('classifies as a structural integrity error, not a transient failure', () => {
    // This is what routes it to the fail-closed error state rather than to a
    // "잠시 후 다시 시도" message or an empty portfolio.
    const error = new TradingAccountScopeMismatchError({
      endpoint: 'GET /positions',
      expectedAccountId: 'acc-1',
      actualAccountId: 'acc-2',
    });

    assert.ok(isTradingAccountScopeMismatchError(error));
    assert.equal(classifyAccountError(error), 'integrity');
  });

  it('does not treat an empty-string account id in the response as a claim', () => {
    const payload = { tradingAccountId: '', orders: [] };

    assert.equal(assertAccountScope('GET /orders', 'acc-1', payload), payload);
  });
});

void mock;
