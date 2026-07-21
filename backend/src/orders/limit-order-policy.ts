import { Prisma } from '../generated/prisma/client';
import { monetaryScale, roundDecimalHalfUp } from '../fx/fx-decimal-policy';

/**
 * Pure calculation/constants for the limit-buy reservation foundation.
 * No provider price is ever an input here: the reservation is derived from
 * the operator-facing limit price and quantity only, using the exact same
 * rounding chain as the market-buy net amount (gross → fee → gross + fee,
 * each ROUND_HALF_UP at the monetary scale).
 */

/** Canonical Order.cancelReason values written by this codebase. */
export const LIMIT_ORDER_CANCEL_REASONS = {
  userCanceled: 'user_canceled',
  seasonEnded: 'season_ended',
  participantExcluded: 'participant_excluded',
} as const;

export type LimitOrderCancelReason =
  (typeof LIMIT_ORDER_CANCEL_REASONS)[keyof typeof LIMIT_ORDER_CANCEL_REASONS];

export type LimitBuyReservationAmounts = {
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  /** grossAmount + feeAmount — the cash locked while the order is open. */
  reservedAmount: Prisma.Decimal;
};

export function calculateLimitBuyReservation(input: {
  limitPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  tradeFeeRate: Prisma.Decimal;
}): LimitBuyReservationAmounts {
  const grossAmount = roundDecimalHalfUp(
    input.quantity.mul(input.limitPrice),
    monetaryScale,
  );
  const feeAmount = roundDecimalHalfUp(
    grossAmount.mul(input.tradeFeeRate),
    monetaryScale,
  );
  const reservedAmount = roundDecimalHalfUp(
    grossAmount.add(feeAmount),
    monetaryScale,
  );
  return { grossAmount, feeAmount, reservedAmount };
}

/** availableAmount = balanceAmount - reservedAmount (never stored in DB). */
export function calculateAvailableAmount(
  balanceAmount: Prisma.Decimal,
  reservedAmount: Prisma.Decimal,
): Prisma.Decimal {
  return balanceAmount.sub(reservedAmount);
}
