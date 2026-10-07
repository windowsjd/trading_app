import type { Prisma, CashWallet } from '../generated/prisma/client';
import { futuresDecimal } from './futures-math';
import {
  accountFuturesFee,
  loadCrossRisk,
  assertCrossSafe,
} from './futures-risk';
import { futuresError } from './futures-error';

/** Caller holds the Futures USD wallet FOR UPDATE for every financial check. */
export async function futuresMarginUsed(
  client: Pick<Prisma.TransactionClient, 'futuresPosition'>,
  accountId: string,
) {
  const result = await client.futuresPosition.aggregate({
    where: {
      tradingAccountId: accountId,
      status: 'open',
      marginMode: 'isolated',
    },
    _sum: { isolatedMargin: true },
  });
  return futuresDecimal(result._sum.isolatedMargin ?? '0');
}

/** Shared USD/FX+Transfer debit seam. Incoming transfers need no margin check. */
export async function assertFuturesTransferCollateral(
  tx: Prisma.TransactionClient,
  source: CashWallet,
  amount: string,
) {
  if (source.walletScope !== 'crypto_futures') return;
  const used = await futuresMarginUsed(tx, source.tradingAccountId);
  if (
    futuresDecimal(source.balanceAmount)
      .sub(source.reservedAmount)
      .sub(used)
      .lt(amount)
  )
    futuresError(
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
      'Transfer would spend isolated Futures collateral.',
    );
  // No mark is required when there are no Cross positions (F1 compatibility).
  const now = (
    await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  )[0].now;
  const cross = await loadCrossRisk(
    tx,
    {
      ...source,
      balanceAmount: futuresDecimal(source.balanceAmount).sub(amount),
    },
    now,
    used,
    await accountFuturesFee(tx, source.tradingAccountId),
  );
  assertCrossSafe(cross.risk!, cross.rows.length > 0);
}
