import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Shared trading-account scope guard for every CashWallet mutation and for
 * every quote that relies on a wallet balance (market/limit order quotes, FX
 * quotes). 작업 5 보완 1.
 *
 * A wallet may only be debited/credited/reserved/released — or used as the
 * balance basis of a new quote — when ALL of the following hold:
 *
 *   wallet.seasonParticipantId === expected participant
 *   wallet.tradingAccountId    !== null
 *   wallet.tradingAccountId    === expected (verified) trading account
 *
 * Violations are SERVER data-integrity states, never client errors, so both
 * throw structured 500s:
 *
 *  - null scope → FINANCIAL_SCOPE_REPAIR_REQUIRED: a deploy-boundary row an
 *    old writer left unscoped. The fix is running
 *    `pnpm trading-accounts:repair-financial-scope --apply` (after
 *    repair-links) — NEVER an in-request backfill: a trade must not be the
 *    thing that decides which account a wallet belongs to.
 *  - participant or account mismatch → FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH:
 *    corrupted linkage. Nothing is overwritten; the request fails closed and
 *    the mismatch is left for operators to investigate.
 *
 * This guard is a pre-check for clear error classification; the atomic SQL
 * in cash-wallet-atomic.ts ALSO carries the tradingAccountId in its WHERE,
 * so a concurrent scope change between the check and the UPDATE still cannot
 * move money under the wrong account.
 */

export const cashWalletScopeErrorCodes = {
  FINANCIAL_SCOPE_REPAIR_REQUIRED: 'FINANCIAL_SCOPE_REPAIR_REQUIRED',
  FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH:
    'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
} as const;

export type CashWalletScopeErrorCode =
  (typeof cashWalletScopeErrorCodes)[keyof typeof cashWalletScopeErrorCodes];

export type CashWalletScopeCandidate = {
  id: string;
  /**
   * Nullable since 작업 6: general-mode wallets have no SeasonParticipant.
   * Every caller of this guard is a SEASON path with a non-null expected
   * participant, so a null here is a mismatch — which is exactly right: a
   * season trade must never reach a general wallet.
   */
  seasonParticipantId: string | null;
  tradingAccountId: string | null;
};

export type ExpectedCashWalletScope = {
  /** Null for a general account, which must never carry participant scope. */
  seasonParticipantId: string | null;
  /** The VERIFIED trading account (participant link / owned account id). */
  tradingAccountId: string;
};

/**
 * Wallet whose scope has been verified: tradingAccountId is proven non-null,
 * so it can feed the account-conditioned atomic SQL without further checks.
 */
export type ScopeVerifiedCashWallet<T extends CashWalletScopeCandidate> = T & {
  tradingAccountId: string;
};

export function assertCashWalletTradingAccountScope<
  T extends CashWalletScopeCandidate,
>(wallet: T, expected: ExpectedCashWalletScope): ScopeVerifiedCashWallet<T> {
  if (wallet.seasonParticipantId !== expected.seasonParticipantId) {
    throwScopeError(
      cashWalletScopeErrorCodes.FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH,
      'Cash wallet participant scope does not match the trading context.',
    );
  }

  if (wallet.tradingAccountId == null) {
    throwScopeError(
      cashWalletScopeErrorCodes.FINANCIAL_SCOPE_REPAIR_REQUIRED,
      'Cash wallet has no trading account scope; run trading-accounts:repair-financial-scope before trading.',
    );
  }

  if (wallet.tradingAccountId !== expected.tradingAccountId) {
    throwScopeError(
      cashWalletScopeErrorCodes.FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH,
      'Cash wallet belongs to a different trading account.',
    );
  }

  return wallet as ScopeVerifiedCashWallet<T>;
}

/**
 * Reports a wallet-scope corruption that is not one of the three linkage
 * cases above (e.g. the resolved wallet's currency does not match the
 * settlement currency) with the SAME structured 500 the linkage checks use.
 */
export function throwCashWalletScopeMismatch(message: string): never {
  throwScopeError(
    cashWalletScopeErrorCodes.FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH,
    message,
  );
}

function throwScopeError(
  code: CashWalletScopeErrorCode,
  message: string,
): never {
  throw new HttpException(
    {
      success: false,
      error: {
        code,
        message,
      },
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
