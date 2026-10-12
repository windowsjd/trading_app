import { Prisma } from '../generated/prisma/client';
import { formatDecimalScale, monetaryScale } from '../fx/fx-decimal-policy';
import type { LimitOnCloseRegistration } from './limit-on-close.policy';
import { sessionDateText } from './limit-on-close.policy';

/** Same transaction as the submitted limit Order and its cash reservation. */
export async function createLimitOnCloseInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    tradingAccountId: string;
    assetId: string;
    registration: LimitOnCloseRegistration;
    now: Date;
  },
) {
  return tx.limitOnCloseOrder.create({
    data: {
      orderId: input.orderId,
      tradingAccountId: input.tradingAccountId,
      assetId: input.assetId,
      market: input.registration.market,
      sessionDate: input.registration.sessionDate,
      sessionOpenAt: input.registration.session.openTime,
      sessionCloseAt: input.registration.session.closeTime,
      evidenceDeadlineAt: input.registration.evidenceDeadlineAt,
      createdAt: input.now,
    },
    select: LIMIT_ON_CLOSE_SELECT,
  });
}

/**
 * Ordinary cancel/lifecycle release of a LOC Order (user, Season end,
 * exclusion). Session decisions write their own terminal status first, so
 * this no-ops for them. Caller holds the Order lock.
 */
export async function limitOnCloseOrderCanceled(
  tx: Prisma.TransactionClient,
  orderId: string,
  reason: string,
  now: Date,
) {
  await tx.limitOnCloseOrder.updateMany({
    where: { orderId, status: 'pending' },
    data: { status: 'canceled', decisionReason: reason, decidedAt: now },
  });
}

export const LIMIT_ON_CLOSE_SELECT = {
  market: true,
  sessionDate: true,
  sessionOpenAt: true,
  sessionCloseAt: true,
  evidenceDeadlineAt: true,
  status: true,
  decisionReason: true,
  decidedAt: true,
  closePrice: true,
  lastCheckCode: true,
  lastCheckedAt: true,
  closeEvidence: {
    select: {
      id: true,
      provider: true,
      sourceName: true,
      providerSymbol: true,
      providerTradingDate: true,
      closePrice: true,
      currencyCode: true,
      status: true,
      firstObservedAt: true,
      finalizedAt: true,
      observationCount: true,
      policyVersion: true,
    },
  },
} as const;

export type LimitOnCloseRecord = Prisma.LimitOnCloseOrderGetPayload<{
  select: typeof LIMIT_ON_CLOSE_SELECT;
}>;

/** Additive order payload block. Only LOC orders carry it. */
export function presentLimitOnClose(row: LimitOnCloseRecord) {
  const evidence = row.closeEvidence;
  return {
    market: row.market,
    sessionDate: sessionDateText(row.sessionDate),
    sessionOpenAt: row.sessionOpenAt.toISOString(),
    sessionCloseAt: row.sessionCloseAt.toISOString(),
    evidenceDeadlineAt: row.evidenceDeadlineAt.toISOString(),
    status: row.status,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    executionPricePolicy: 'final_regular_session_close' as const,
    closePrice: row.closePrice
      ? formatDecimalScale(row.closePrice, monetaryScale)
      : null,
    lastCheckCode: row.lastCheckCode,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    closeEvidence: evidence
      ? {
          id: evidence.id,
          provider: evidence.provider,
          sourceName: evidence.sourceName,
          providerSymbol: evidence.providerSymbol,
          providerTradingDate: evidence.providerTradingDate,
          closePrice: formatDecimalScale(evidence.closePrice, monetaryScale),
          currencyCode: evidence.currencyCode,
          status: evidence.status,
          firstObservedAt: evidence.firstObservedAt.toISOString(),
          finalizedAt: evidence.finalizedAt?.toISOString() ?? null,
          observationCount: evidence.observationCount,
          policyVersion: evidence.policyVersion,
        }
      : null,
  };
}

export type LimitOnClosePayload = ReturnType<typeof presentLimitOnClose>;
