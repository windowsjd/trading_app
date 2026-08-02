import { HttpException } from '@nestjs/common';
import {
  assertCashWalletTradingAccountScope,
  cashWalletScopeErrorCodes,
} from './cash-wallet-scope';

const expectedScope = {
  seasonParticipantId: 'participant-1',
  tradingAccountId: 'account-1',
};

function getError(fn: () => unknown): {
  status: number;
  code: string;
} {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpException) {
      const response = error.getResponse() as {
        error?: { code?: string };
      };
      return {
        status: error.getStatus(),
        code: response.error?.code ?? '',
      };
    }
    throw error;
  }
  throw new Error('expected the assertion to throw');
}

describe('assertCashWalletTradingAccountScope', () => {
  it('returns the wallet when participant and account both match', () => {
    const wallet = {
      id: 'wallet-1',
      seasonParticipantId: 'participant-1',
      tradingAccountId: 'account-1',
      balanceAmount: '100',
    };

    const verified = assertCashWalletTradingAccountScope(wallet, expectedScope);

    expect(verified).toBe(wallet);
    // The narrowed type proves non-null scope for the atomic SQL input.
    expect(verified.tradingAccountId).toBe('account-1');
  });

  it('fails closed with a 500 repair-required error on a NULL wallet scope', () => {
    const { status, code } = getError(() =>
      assertCashWalletTradingAccountScope(
        {
          id: 'wallet-1',
          seasonParticipantId: 'participant-1',
          tradingAccountId: null,
        },
        expectedScope,
      ),
    );

    expect(status).toBe(500);
    expect(code).toBe(
      cashWalletScopeErrorCodes.FINANCIAL_SCOPE_REPAIR_REQUIRED,
    );
  });

  it('fails closed with a 500 mismatch error on a foreign account scope', () => {
    const { status, code } = getError(() =>
      assertCashWalletTradingAccountScope(
        {
          id: 'wallet-1',
          seasonParticipantId: 'participant-1',
          tradingAccountId: 'account-OTHER',
        },
        expectedScope,
      ),
    );

    expect(status).toBe(500);
    expect(code).toBe(
      cashWalletScopeErrorCodes.FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH,
    );
  });

  it('fails closed with a 500 mismatch error on a foreign participant', () => {
    const { status, code } = getError(() =>
      assertCashWalletTradingAccountScope(
        {
          id: 'wallet-1',
          seasonParticipantId: 'participant-OTHER',
          // Even a "correct" account cannot save a wrong participant link.
          tradingAccountId: 'account-1',
        },
        expectedScope,
      ),
    );

    expect(status).toBe(500);
    expect(code).toBe(
      cashWalletScopeErrorCodes.FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH,
    );
  });

  it('checks the participant before the null-scope classification', () => {
    // A foreign participant with a null scope is a MISMATCH, not a
    // repair-required state: repairing would attach the wrong account.
    const { code } = getError(() =>
      assertCashWalletTradingAccountScope(
        {
          id: 'wallet-1',
          seasonParticipantId: 'participant-OTHER',
          tradingAccountId: null,
        },
        expectedScope,
      ),
    );

    expect(code).toBe(
      cashWalletScopeErrorCodes.FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH,
    );
  });
});
