import { type FuturesLimitOrder, Prisma } from '../generated/prisma/client';
import { releaseReservedCash } from '../wallets/cash-wallet-atomic';
import { finishProtection } from '../conditional/conditional-state';
import { futuresError } from './futures-error';
import { setAdminDiagnosticContext } from '../common/admin-diagnostics';

/** Caller owns the account/lifecycle fence and then the Futures wallet fence. */
export async function releaseFuturesEntryReservation(
  tx: Prisma.TransactionClient,
  order: FuturesLimitOrder,
) {
  const wallet = await tx.cashWallet.findFirst({
    where: {
      tradingAccountId: order.tradingAccountId,
      walletScope: 'crypto_futures',
      currencyCode: 'USD',
    },
  });
  const released =
    wallet &&
    (await releaseReservedCash(tx, {
      walletId: wallet.id,
      tradingAccountId: order.tradingAccountId,
      walletScope: 'crypto_futures',
      currencyCode: 'USD',
      amount: order.reservedAmount.toFixed(8),
    }));
  if (released !== 1) {
    setAdminDiagnosticContext({
      domain: 'futures',
      operation: 'FUTURES_LIMIT_ENTRY',
      failureStage: 'futures_entry_reservation_release',
      evidence: {
        financialGuard: {
          guardName: 'futures_entry_reservation',
          walletScope: 'crypto_futures',
          currencyCode: 'USD',
          walletFound: !!wallet,
          reservationSufficient: false,
          mutationResult: 'rejected',
        },
      },
    });
    futuresError(
      'FINANCIAL_SCOPE_REPAIR_REQUIRED',
      'Futures wallet information could not be verified.',
      500,
    );
  }
}

/** Also used by lifecycle cleanup under its existing financial fence. */
export async function cancelFuturesEntriesInTransaction(
  tx: Prisma.TransactionClient,
  accountId: string,
  reason: string,
  now: Date,
  orderId?: string,
) {
  await tx.$queryRaw`SELECT id FROM cash_wallets WHERE trading_account_id = ${accountId} AND wallet_scope = 'crypto_futures' AND currency_code = 'USD' FOR UPDATE`;
  const orders = await tx.futuresLimitOrder.findMany({
    where: {
      tradingAccountId: accountId,
      status: 'submitted',
      ...(orderId ? { id: orderId } : {}),
    },
    orderBy: { id: 'asc' },
  });
  for (const order of orders) {
    await releaseFuturesEntryReservation(tx, order);
    await tx.futuresLimitOrder.update({
      where: { id: order.id },
      data: { status: 'canceled', terminalReason: reason, endedAt: now },
    });
    const group = await tx.protectionGroup.findUnique({
      where: { parentFuturesOrderId: order.id },
    });
    if (group?.status === 'holding')
      await finishProtection(tx, group.id, 'canceled', reason, now);
  }
  return orders.length;
}
