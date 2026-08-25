import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getKnownWalletBalanceAmount } from './mapper.ts';

describe('status-aware wallet balance display', () => {
  it('keeps an unfetched or absent wallet unknown', () => {
    assert.equal(getKnownWalletBalanceAmount(undefined, 'KRW'), null);
    assert.equal(getKnownWalletBalanceAmount({ wallets: [] }, 'KRW'), null);
  });

  it('distinguishes a real zero from a positive API balance', () => {
    const wallets = {
      wallets: [
        { currencyCode: 'KRW' as const, balanceAmount: '7502495.13164150' },
        { currencyCode: 'USD' as const, balanceAmount: '0.00000000' },
      ],
    };

    assert.equal(
      getKnownWalletBalanceAmount(wallets, 'KRW'),
      '7502495.13164150',
    );
    assert.equal(getKnownWalletBalanceAmount(wallets, 'USD'), '0.00000000');
  });
});
