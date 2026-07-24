import { Prisma } from '../generated/prisma/client';
import { monetaryScale, roundDecimalHalfUp } from '../fx/fx-decimal-policy';

/**
 * Pure fill arithmetic for a limit-buy execution. The rounding chain is
 * identical to the market-buy money path (gross → fee → gross + fee, each
 * ROUND_HALF_UP at the monetary scale), so a limit fill and a market fill at
 * the same price produce the same amounts. The only difference from market is
 * the inputs: the fee rate is the order's PINNED reservationFeeRate (never the
 * live season rate), and the price is the path's execution price (path A: the
 * fresh snapshot price; path B: the order's limitPrice).
 */
export type LimitFillAmounts = {
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  /** grossAmount + feeAmount — the actual cash debited from balance. */
  netAmount: Prisma.Decimal;
};

export function calculateLimitFillAmounts(input: {
  executedPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  reservationFeeRate: Prisma.Decimal;
}): LimitFillAmounts {
  const grossAmount = roundDecimalHalfUp(
    input.quantity.mul(input.executedPrice),
    monetaryScale,
  );
  const feeAmount = roundDecimalHalfUp(
    grossAmount.mul(input.reservationFeeRate),
    monetaryScale,
  );
  const netAmount = roundDecimalHalfUp(
    grossAmount.add(feeAmount),
    monetaryScale,
  );
  return { grossAmount, feeAmount, netAmount };
}

/**
 * The invariant the whole reservation model rests on: because the fill price
 * is at or below the limit price and the fee rate is the one the reservation
 * was sized with, the actual debit can never exceed the order's reservation.
 * A violation is an unrecoverable inconsistency (never a silent extra debit),
 * so callers must fail the fill on `false`.
 */
export function isFillWithinReservation(
  netAmount: Prisma.Decimal,
  reservedAmount: Prisma.Decimal,
): boolean {
  return netAmount.lte(reservedAmount);
}

/**
 * Buy-side position average cost, identical to the market-buy policy
 * (fee-inclusive net cost basis). For a brand-new position the average cost is
 * the net paid per unit; for an existing one it is the cost-weighted blend.
 */
export function calculateBuyPositionAverageCost(input: {
  netAmount: Prisma.Decimal;
  quantity: Prisma.Decimal;
  existing?: {
    quantity: Prisma.Decimal;
    averageCost: Prisma.Decimal;
  } | null;
}): { newQuantity: Prisma.Decimal; newAverageCost: Prisma.Decimal } {
  if (!input.existing) {
    return {
      newQuantity: input.quantity,
      newAverageCost: roundDecimalHalfUp(
        input.netAmount.div(input.quantity),
        monetaryScale,
      ),
    };
  }

  const newQuantity = roundDecimalHalfUp(
    input.existing.quantity.add(input.quantity),
    monetaryScale,
  );
  const oldCostBasis = input.existing.averageCost.mul(input.existing.quantity);
  const newAverageCost = roundDecimalHalfUp(
    oldCostBasis.add(input.netAmount).div(newQuantity),
    monetaryScale,
  );
  return { newQuantity, newAverageCost };
}
