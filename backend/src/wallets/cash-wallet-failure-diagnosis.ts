import { Prisma } from '../generated/prisma/client';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import {
  assertCashWalletTradingAccountScope,
  throwCashWalletScopeMismatch,
} from './cash-wallet-scope';

/**
 * Shared "why did the guarded wallet UPDATE affect 0 rows?" classifier
 * (작업 5 보완 3).
 *
 * Every atomic cash mutation in cash-wallet-atomic.ts (and the equivalent
 * Prisma updateMany credits) carries the wallet id, the VERIFIED trading
 * account, securities scope, the currency, AND an amount guard in one WHERE.
 * When it matches 0 rows, ANY of those could be the reason — and the old
 * per-caller diagnostics re-read the wallet with the scope columns still in
 * the WHERE, so a wallet whose scope had been corrupted simply "disappeared"
 * and was reported as a missing wallet or a generic concurrency CONFLICT.
 *
 * This helper re-reads the wallet BY ID ALONE inside the same transaction, so
 * scope corruption is visible instead of self-concealing, and classifies in
 * the fixed order:
 *
 *   1. wallet row gone                       → 'wallet_not_found'
 *   2. tradingAccountId IS NULL              → 500 repair required (throws)
 *   3. tradingAccountId differs              → 500 scope mismatch (throws)
 *   4. walletScope is not securities         → 500 scope mismatch (throws)
 *   5. currencyCode differs                  → 500 scope mismatch (throws)
 *   6. amount guard cannot hold              → 'insufficient_available' /
 *                                              'insufficient_reserved'
 *   7. scope AND amounts fine                → 'conflict' (real concurrency)
 *
 * Steps 2–5 are structural server-side corruption and are thrown here as the
 * SAME structured 500s the pre-check guard uses
 * (FINANCIAL_SCOPE_REPAIR_REQUIRED / FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH)
 * so every caller reports them identically. Steps 1, 6, 7 are returned so each
 * caller can keep its own historical error code (INSUFFICIENT_BALANCE,
 * INSUFFICIENT_AVAILABLE_BALANCE, ORDER_RESERVATION_INCONSISTENT,
 * SOURCE_WALLET_NOT_FOUND, …).
 *
 * The diagnosis is READ-ONLY: it never writes, repairs, or backfills.
 */

type DiagnosisClient = Pick<Prisma.TransactionClient, 'cashWallet'>;

export type CashWalletFailureReason =
  | 'wallet_not_found'
  /** balance - reserved could not cover the requested debit/reservation. */
  | 'insufficient_available'
  /** balance alone could not cover the requested debit. */
  | 'insufficient_balance'
  /** reserved_amount did not cover the reservation being released/settled. */
  | 'insufficient_reserved'
  /** Observed scope/amounts hold; concurrency is inferred, not writer attribution. */
  | 'conflict';

export type CashWalletAmountRequirement = {
  /** Requires balance_amount - reserved_amount >= value. */
  available?: Prisma.Decimal | string;
  /** Requires balance_amount >= value. */
  balance?: Prisma.Decimal | string;
  /** Requires reserved_amount >= value. */
  reserved?: Prisma.Decimal | string;
};

export async function diagnoseCashWalletMutationFailure(
  client: DiagnosisClient,
  input: {
    walletId: string;
    expected: {
      /** The VERIFIED trading account the mutation was scoped to. */
      tradingAccountId: string;
      /** CurrencyCode enum value. */
      currencyCode: string;
    };
    /** Amount guards that were part of the failed UPDATE's WHERE. */
    requires?: CashWalletAmountRequirement;
    /** Opt in at the order call site; other financial workflows are unchanged. */
    diagnostic?: {
      financialOperation: string;
      failureStage: string;
      mutationAffected: number;
    };
  },
): Promise<CashWalletFailureReason> {
  // BY ID ONLY — re-applying the scope columns here is exactly what hid the
  // corruption before.
  const wallet = await client.cashWallet.findUnique({
    where: { id: input.walletId },
    select: {
      walletScope: true,
      id: true,
      tradingAccountId: true,
      currencyCode: true,
      balanceAmount: true,
      reservedAmount: true,
    },
  });

  const requires = input.requires ?? {};
  const reserved = wallet?.reservedAmount ?? new Prisma.Decimal(0);
  const scopeValid = wallet
    ? wallet.tradingAccountId === input.expected.tradingAccountId &&
      wallet.walletScope === 'securities'
    : undefined;
  const currencyMatched = wallet
    ? wallet.currencyCode === input.expected.currencyCode
    : undefined;
  const validWallet = wallet && scopeValid && currencyMatched ? wallet : null;
  const balanceRequirement = requires.balance ?? requires.available;
  const evidence = {
    walletFound: !!wallet,
    scopeValid,
    currencyMatched,
    availableSufficient:
      validWallet && requires.available !== undefined
        ? validWallet.balanceAmount.sub(reserved).gte(requires.available)
        : undefined,
    balanceSufficient:
      validWallet && balanceRequirement !== undefined
        ? validWallet.balanceAmount.gte(balanceRequirement)
        : undefined,
    reservedSufficient:
      validWallet && requires.reserved !== undefined
        ? reserved.gte(requires.reserved)
        : undefined,
    reservedCashPresent: validWallet ? reserved.gt(0) : undefined,
  };
  const recordReason = (failureReason: string) => {
    if (!input.diagnostic) return;
    setAdminDiagnosticContext({
      failureStage: input.diagnostic.failureStage,
      evidence: {
        financialGuard: {
          financialOperation: input.diagnostic.financialOperation,
          guardName:
            requires.available !== undefined
              ? 'available_cash'
              : requires.reserved !== undefined
                ? 'reserved_cash'
                : requires.balance !== undefined
                  ? 'cash_balance'
                  : 'wallet_scope',
          mutationResult: 'rejected',
          mutationAffected: input.diagnostic.mutationAffected,
          observation: 'failure_read',
          failureReason,
          ...evidence,
        },
      },
    });
  };

  if (!wallet) {
    recordReason('wallet_not_found');
    return 'wallet_not_found';
  }

  if (!scopeValid) {
    recordReason(
      wallet.tradingAccountId == null
        ? 'null_scope'
        : wallet.tradingAccountId !== input.expected.tradingAccountId
          ? 'account_scope_mismatch'
          : 'wallet_scope_mismatch',
    );
  } else if (!currencyMatched) {
    recordReason('currency_mismatch');
  }

  // Throws FINANCIAL_SCOPE_REPAIR_REQUIRED (null scope) or
  // FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH (account mismatch).
  assertCashWalletTradingAccountScope(wallet, {
    tradingAccountId: input.expected.tradingAccountId,
  });

  if (wallet.currencyCode !== input.expected.currencyCode) {
    // The wallet the caller resolved is not the currency it settled in:
    // structural corruption, reported like any other scope mismatch.
    throwCashWalletScopeMismatch(
      'Cash wallet currency does not match the settlement currency.',
    );
  }

  if (
    requires.available !== undefined &&
    wallet.balanceAmount
      .sub(reserved)
      .lt(new Prisma.Decimal(requires.available))
  ) {
    recordReason('insufficient_available');
    return 'insufficient_available';
  }

  if (
    requires.balance !== undefined &&
    wallet.balanceAmount.lt(new Prisma.Decimal(requires.balance))
  ) {
    recordReason('insufficient_balance');
    return 'insufficient_balance';
  }

  if (
    requires.reserved !== undefined &&
    reserved.lt(new Prisma.Decimal(requires.reserved))
  ) {
    recordReason('insufficient_reserved');
    return 'insufficient_reserved';
  }

  recordReason('conflict');
  return 'conflict';
}
