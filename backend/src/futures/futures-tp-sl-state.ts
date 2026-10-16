import { Prisma } from '../generated/prisma/client';
import { futuresError } from './futures-error';
import { futuresTpSlWindowExpired } from './futures-tp-sl-policy';

/** Watching or triggered-but-not-yet-executed. Nothing else can act. */
export const liveFuturesTpSl = {
  status: { in: ['watching', 'triggered'] as ('watching' | 'triggered')[] },
};

export type FuturesTpSlLifecycleReason =
  | 'user_canceled'
  | 'season_ended'
  | 'participant_excluded'
  | 'account_not_tradable';

/** Caller holds the account/lifecycle fence. Settings reserve nothing. */
export async function cancelLiveFuturesTpSlInTransaction(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  reason: FuturesTpSlLifecycleReason,
  now: Date,
) {
  const result = await tx.futuresTpSlSetting.updateMany({
    where: { tradingAccountId, ...liveFuturesTpSl },
    data: { status: 'canceled', terminalReason: reason, endedAt: now },
  });
  return result.count;
}

/**
 * Same transaction as whatever ends a Futures lifetime (a manual or TP/SL
 * full close, liquidation, Season final settlement): every live setting of
 * that lifetime ends with it, so a later position on the instrument never
 * inherits them. A setting already linked to its execution is untouched.
 */
export async function closeFuturesTpSlForPosition(
  tx: Prisma.TransactionClient,
  positionId: string,
  reason: string,
  now: Date,
) {
  const result = await tx.futuresTpSlSetting.updateMany({
    where: { positionId, ...liveFuturesTpSl },
    data: { status: 'canceled', terminalReason: reason, endedAt: now },
  });
  return result.count;
}

/**
 * Internal worker capability inside FuturesService.execute, after its
 * lifecycle, wallet and position locks: the setting must still be triggered
 * and unlinked, bound to the open lifetime being reduced, the request must be
 * a reduce/close of at most its target, and the 30 s window must still be
 * open at the DB clock after this lock. A concurrent user cancel or lifetime
 * close either committed first (this execution fails) or waits behind the
 * account fence.
 */
export async function lockTriggeredFuturesTpSl(
  tx: Prisma.TransactionClient,
  id: string,
  tradingAccountId: string,
  request: {
    positionId: string | null;
    operation: string;
    direction: string;
    quantity: string;
  },
) {
  await tx.$queryRaw`SELECT "id" FROM "futures_tp_sl_settings" WHERE "id" = ${id} AND "trading_account_id" = ${tradingAccountId} FOR UPDATE`;
  const row = await tx.futuresTpSlSetting.findFirst({
    where: { id, tradingAccountId },
  });
  if (
    !row ||
    row.status !== 'triggered' ||
    row.executionId !== null ||
    row.positionId !== request.positionId ||
    row.direction !== request.direction ||
    (request.operation !== 'reduce' && request.operation !== 'close') ||
    new Prisma.Decimal(request.quantity).gt(row.quantity)
  )
    futuresError(
      'FUTURES_TP_SL_CHANGED',
      'The stop-loss or take-profit setting changed before execution.',
    );
  await assertFuturesTpSlExecutionWindow(tx, row.triggeredAt);
  return row;
}

/**
 * The execution window at the executing transaction's DB clock: after the
 * setting lock and again as the link's last check, so neither a slow price
 * read nor a lock wait turns a trigger 30 s old or older into an execution.
 */
export async function assertFuturesTpSlExecutionWindow(
  tx: Prisma.TransactionClient,
  triggeredAt: Date | null,
) {
  const [{ now }] = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS "now"`;
  if (!triggeredAt || futuresTpSlWindowExpired(triggeredAt, now))
    futuresError(
      'FUTURES_TP_SL_EXECUTION_WINDOW_EXPIRED',
      'The stop-loss or take-profit trigger is too old to execute.',
    );
}

/** Same transaction as the FuturesExecution insert. */
export async function linkFuturesTpSlExecution(
  tx: Prisma.TransactionClient,
  id: string,
  tradingAccountId: string,
  executionId: string,
  now: Date,
) {
  const linked = await tx.futuresTpSlSetting.updateMany({
    where: { id, tradingAccountId, status: 'triggered', executionId: null },
    data: {
      status: 'ordered',
      executionId,
      endedAt: now,
      lastAttemptAt: now,
      attemptCount: { increment: 1 },
      failureCode: null,
    },
  });
  if (linked.count !== 1)
    futuresError(
      'FUTURES_TP_SL_CHANGED',
      'The stop-loss or take-profit setting changed before execution.',
    );
}
