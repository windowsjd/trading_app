import { Prisma, type CashWallet } from '../generated/prisma/client';
import { debitAvailableCash } from '../wallets/cash-wallet-atomic';
import { futuresDecimal as d, assertFuturesMoney } from './futures-math';
import { futuresError } from './futures-error';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';

/** Shared cash/fee/ledger primitive for user executions and system liquidations.
 * Caller holds the account/wallet fence and has checked its collateral scope.
 * Economic loss is never changed here: bankruptcy allocation is explicit upstream. */
export async function settleFuturesCash(
  tx: Prisma.TransactionClient,
  wallet: CashWallet,
  referenceType: 'futures_execution' | 'futures_liquidation',
  referenceId: string,
  pnl: Prisma.Decimal,
  fee: Prisma.Decimal,
  now: Date,
) {
  const ledger: Prisma.WalletTransactionCreateManyInput[] = [];
  let balance = d(wallet.balanceAmount);
  const debit = async (amount: Prisma.Decimal) => {
    if (
      (await debitAvailableCash(tx, {
        walletId: wallet.id,
        tradingAccountId: wallet.tradingAccountId,
        walletScope: 'crypto_futures',
        currencyCode: 'USD',
        amount: amount.toFixed(8),
      })) !== 1
    )
      futuresError(
        'FUTURES_CASH_CONFLICT',
        'Futures collateral could not be settled. Please try again.',
      );
  };
  const entry = (
    txType: 'futures_pnl' | 'fee',
    amount: Prisma.Decimal,
    direction: 'credit' | 'debit',
  ) =>
    ledger.push({
      tradingAccountId: wallet.tradingAccountId,
      walletId: wallet.id,
      currencyCode: 'USD',
      direction,
      txType,
      referenceType,
      referenceId,
      amount: amount.toFixed(8),
      balanceAfter: balance.toFixed(8),
      occurredAt: now,
    });
  setAdminDiagnosticContext({
    failureStage: 'futures_realized_pnl_settlement',
  });
  if (!pnl.eq(0)) {
    if (pnl.lt(0)) await debit(pnl.abs());
    else {
      const credit = await tx.cashWallet.updateMany({
        where: {
          id: wallet.id,
          tradingAccountId: wallet.tradingAccountId,
          walletScope: 'crypto_futures',
          currencyCode: 'USD',
        },
        data: { balanceAmount: { increment: pnl.toFixed(8) } },
      });
      if (credit.count !== 1)
        futuresError(
          'FUTURES_CASH_CONFLICT',
          'Futures collateral could not be settled. Please try again.',
        );
    }
    balance = assertFuturesMoney(balance.add(pnl));
    entry('futures_pnl', pnl.abs(), pnl.gt(0) ? 'credit' : 'debit');
  }
  setAdminDiagnosticContext({ failureStage: 'futures_fee_debit' });
  if (fee.gt(0)) await debit(fee);
  balance = assertFuturesMoney(balance.sub(fee));
  entry('fee', fee, 'debit');
  return { balance, ledger };
}
export function bankruptcySettlement(
  collateral: Prisma.Decimal,
  economicPnl: Prisma.Decimal,
  fee: Prisma.Decimal,
) {
  if (collateral.lt(0))
    futuresError(
      'FUTURES_COLLATERAL_INTEGRITY',
      'Futures collateral information could not be verified.',
    );
  const settledPnl = economicPnl.lt(collateral.neg())
    ? collateral.neg()
    : economicPnl;
  const remaining = collateral.add(settledPnl);
  const settledFee = fee.gt(remaining) ? remaining : fee;
  const settledCash = settledPnl.sub(settledFee);
  return {
    settledPnl,
    settledFee,
    settledCash,
    bankruptcyShortfall: settledCash.sub(economicPnl).add(fee),
  };
}
