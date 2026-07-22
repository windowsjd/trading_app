import { Prisma } from '../../generated/prisma/client';
import {
  feeRateScale,
  monetaryScale,
  roundDecimalHalfUp,
} from '../../fx/fx-decimal-policy';

export type LimitOrderExecutionAmounts = {
  executedPrice: Prisma.Decimal;
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  actualDebit: Prisma.Decimal;
  reservationRelease: Prisma.Decimal;
  priceImprovementAmount: Prisma.Decimal;
};

export function calculateLimitOrderExecutionAmounts(input: {
  eventPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  reservationFeeRate: Prisma.Decimal;
  reservedAmount: Prisma.Decimal;
}): LimitOrderExecutionAmounts {
  const grossAmount = roundDecimalHalfUp(
    input.eventPrice.mul(input.quantity),
    monetaryScale,
  );
  const feeRate = roundDecimalHalfUp(input.reservationFeeRate, feeRateScale);
  const feeAmount = roundDecimalHalfUp(grossAmount.mul(feeRate), monetaryScale);
  const actualDebit = roundDecimalHalfUp(
    grossAmount.add(feeAmount),
    monetaryScale,
  );
  if (actualDebit.gt(input.reservedAmount)) {
    throw new Error('LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT');
  }
  return {
    executedPrice: input.eventPrice,
    grossAmount,
    feeAmount,
    actualDebit,
    reservationRelease: input.reservedAmount,
    priceImprovementAmount: input.reservedAmount.sub(actualDebit),
  };
}

export class LimitOrderCandleReservationMismatchError extends Error {
  readonly code = 'LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH';
  constructor(readonly detail: { expected: string; actual: string }) {
    super(
      `Recomputed path-B debit ${detail.actual} does not equal the order reservation ${detail.expected}.`,
    );
    this.name = 'LimitOrderCandleReservationMismatchError';
  }
}

/**
 * Path B (closed 5m candle safety net) amounts.
 *
 * executedPrice is the ORDER'S LIMIT PRICE, never the candle low: a 5-minute
 * low proves only that the limit was touched somewhere inside the window, not
 * that a fill was obtainable there, and paying out the low would hand the user
 * an advantage a real book would not.
 *
 * Because the reservation was computed from the same limit price with the same
 * pinned fee rate and the same rounding, the recomputed debit MUST equal the
 * reservation exactly. Any drift is an unresolved inconsistency, so it raises
 * instead of debiting an amount nobody reserved.
 */
export function calculateLimitOrderCandleExecutionAmounts(input: {
  limitPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  reservationFeeRate: Prisma.Decimal;
  reservedAmount: Prisma.Decimal;
}): LimitOrderExecutionAmounts {
  const grossAmount = roundDecimalHalfUp(
    input.limitPrice.mul(input.quantity),
    monetaryScale,
  );
  const feeRate = roundDecimalHalfUp(input.reservationFeeRate, feeRateScale);
  const feeAmount = roundDecimalHalfUp(grossAmount.mul(feeRate), monetaryScale);
  const actualDebit = roundDecimalHalfUp(
    grossAmount.add(feeAmount),
    monetaryScale,
  );
  if (!actualDebit.eq(input.reservedAmount)) {
    throw new LimitOrderCandleReservationMismatchError({
      expected: input.reservedAmount.toString(),
      actual: actualDebit.toString(),
    });
  }
  return {
    executedPrice: input.limitPrice,
    grossAmount,
    feeAmount,
    actualDebit,
    reservationRelease: input.reservedAmount,
    priceImprovementAmount: new Prisma.Decimal(0),
  };
}
