import type { CurrencyCode, WalletScope } from '../generated/prisma/client';

export type CashWalletIdentity = {
  walletScope: WalletScope;
  currencyCode: CurrencyCode;
};

/** The complete cash container set, independent of current order/FX routing. */
export const CANONICAL_CASH_WALLET_IDENTITIES = [
  { walletScope: 'securities', currencyCode: 'KRW' },
  { walletScope: 'securities', currencyCode: 'USD' },
  { walletScope: 'crypto_spot', currencyCode: 'USD' },
  { walletScope: 'crypto_futures', currencyCode: 'USD' },
] as const satisfies readonly CashWalletIdentity[];

/** Zero containers only; callers keep their existing provisioning transaction. */
export function zeroCryptoCashWalletData(tradingAccountId: string) {
  return CANONICAL_CASH_WALLET_IDENTITIES.filter(
    (identity) => identity.walletScope !== 'securities',
  ).map((identity) => ({
    ...identity,
    tradingAccountId,
    balanceAmount: '0.00000000',
    reservedAmount: '0.00000000',
  }));
}

/** Read-only shape validation; never synthesizes missing wallets or balances. */
export function canonicalCashWalletSetIssue(
  wallets: readonly CashWalletIdentity[],
): 'missing' | 'invalid' | null {
  const counts = CANONICAL_CASH_WALLET_IDENTITIES.map(
    (identity) =>
      wallets.filter(
        (wallet) =>
          wallet.walletScope === identity.walletScope &&
          wallet.currencyCode === identity.currencyCode,
      ).length,
  );
  if (
    counts.some((count) => count > 1) ||
    counts.reduce((sum, count) => sum + count, 0) !== wallets.length
  ) {
    return 'invalid';
  }
  return counts.some((count) => count === 0) ? 'missing' : null;
}
