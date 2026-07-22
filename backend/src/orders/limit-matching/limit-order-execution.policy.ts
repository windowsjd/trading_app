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
