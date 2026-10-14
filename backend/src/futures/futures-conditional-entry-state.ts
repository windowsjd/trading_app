import { Prisma } from '../generated/prisma/client';
import { futuresError } from './futures-error';
import { futuresConditionalEntryWindowExpired } from './futures-conditional-entry-policy';

/** Watching or triggered-but-not-yet-ordered. Nothing else can act. */
export const liveFuturesConditionalEntry = {
  status: { in: ['watching', 'triggered'] as ('watching' | 'triggered')[] },
};

/**
 * Read filter `state=open`: everything the owner can still cancel — a live
 * watch, or a watch whose linked Futures limit entry is still `submitted`
 * (canceled through the ordinary limit-entry cancel). `state=ended` is its
 * complement; ended rows never become open again.
 */
export const openFuturesConditionalEntry: Prisma.FuturesConditionalEntryWhereInput =
  {
    OR: [
      liveFuturesConditionalEntry,
      { status: 'ordered', limitOrder: { is: { status: 'submitted' } } },
    ],
  };

export type FuturesConditionalEntryLifecycleReason =
  | 'user_canceled'
  | 'season_ended'
  | 'participant_excluded'
  | 'account_not_tradable'
  | 'instrument_not_tradable';

/** Caller holds the account/lifecycle fence. Watches reserve nothing. */
export async function cancelLiveFuturesConditionalEntriesInTransaction(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  reason: FuturesConditionalEntryLifecycleReason,
  now: Date,
) {
  const result = await tx.futuresConditionalEntry.updateMany({
    where: { tradingAccountId, ...liveFuturesConditionalEntry },
    data: { status: 'canceled', terminalReason: reason, endedAt: now },
  });
  return result.count;
}

/** The exact registered intent the worker asks a Futures service to create. */
export type FuturesConditionalEntryIntent = {
  executionType: 'market' | 'limit';
  instrumentId: string;
  direction: string;
  marginMode: string;
  leverage: number;
  quantity: string;
  limitPrice: string | null;
};

/**
 * Internal worker capability inside the Futures execution / limit-entry
 * creation transaction, after its lifecycle and wallet fences: the entry must
 * still be triggered and unlinked, the request must be exactly the registered
 * intent, and the 30 s window must still be open at the DB clock after this
 * lock. A concurrent user cancel either committed first (this creation fails)
 * or waits behind this lock and then sees `ordered`.
 */
export async function lockTriggeredFuturesConditionalEntry(
  tx: Prisma.TransactionClient,
  id: string,
  tradingAccountId: string,
  intent: FuturesConditionalEntryIntent,
) {
  await tx.$queryRaw`SELECT "id" FROM "futures_conditional_entries" WHERE "id" = ${id} AND "trading_account_id" = ${tradingAccountId} FOR UPDATE`;
  const row = await tx.futuresConditionalEntry.findFirst({
    where: { id, tradingAccountId },
  });
  if (
    !row ||
    row.status !== 'triggered' ||
    row.executionId !== null ||
    row.limitOrderId !== null ||
    row.executionType !== intent.executionType ||
    row.instrumentId !== intent.instrumentId ||
    row.direction !== intent.direction ||
    row.marginMode !== intent.marginMode ||
    row.leverage !== intent.leverage ||
    !row.quantity.eq(intent.quantity) ||
    (row.limitPrice === null
      ? intent.limitPrice !== null
      : intent.limitPrice === null || !row.limitPrice.eq(intent.limitPrice))
  )
    futuresError(
      'FUTURES_CONDITIONAL_ENTRY_CHANGED',
      'The conditional entry changed before execution.',
    );
  await assertFuturesConditionalEntryWindow(tx, row.triggeredAt);
  return row;
}

/**
 * The execution window at the creating transaction's DB clock. Checked after
 * the entry lock and again as the transaction's last statement, so neither a
 * slow price read nor a lock wait turns a trigger 30 s old or older into an
 * order. A committed command replays before either check.
 */
export async function assertFuturesConditionalEntryWindow(
  tx: Prisma.TransactionClient,
  triggeredAt: Date | null,
) {
  const [{ now }] = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS "now"`;
  if (!triggeredAt || futuresConditionalEntryWindowExpired(triggeredAt, now))
    futuresError(
      'FUTURES_CONDITIONAL_ENTRY_EXECUTION_WINDOW_EXPIRED',
      'The conditional entry trigger is too old to execute.',
    );
}

/** Same transaction as the execution / limit entry insert. */
export async function linkFuturesConditionalEntry(
  tx: Prisma.TransactionClient,
  id: string,
  tradingAccountId: string,
  link: { executionId: string } | { limitOrderId: string },
  now: Date,
) {
  const linked = await tx.futuresConditionalEntry.updateMany({
    where: {
      id,
      tradingAccountId,
      status: 'triggered',
      executionId: null,
      limitOrderId: null,
    },
    data: {
      status: 'ordered',
      ...link,
      endedAt: now,
      lastAttemptAt: now,
      attemptCount: { increment: 1 },
      failureCode: null,
    },
  });
  if (linked.count !== 1)
    futuresError(
      'FUTURES_CONDITIONAL_ENTRY_CHANGED',
      'The conditional entry changed before execution.',
    );
}
