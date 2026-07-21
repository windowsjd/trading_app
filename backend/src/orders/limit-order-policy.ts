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

/**
 * Inclusive upper bound for a pinned quote fee rate. Season.trade_fee_rate is
 * Decimal(10,6); a rate above 100% would mean the fee exceeds the notional and
 * is treated as corrupt data rather than an expensive season.
 *
 * Kept as a decimal STRING and compared via Decimal.gt so this module has no
 * import-time dependency on a constructible Prisma.Decimal — several specs
 * mock the generated client and would otherwise fail to load the module.
 */
export const MAX_QUOTED_FEE_RATE = '1';

/**
 * The reservation basis pinned on the durable quote at quote time. Create
 * reserves exactly these amounts, so a Season.tradeFeeRate change between
 * quote and create cannot move the user's reservation.
 */
export type QuotedLimitReservationBasis = {
  quotedFeeRate: Prisma.Decimal;
  quotedGrossAmount: Prisma.Decimal;
  quotedFeeAmount: Prisma.Decimal;
  quotedReservedAmount: Prisma.Decimal;
};

export type QuotedLimitReservationBasisResult =
  | { ok: true; basis: QuotedLimitReservationBasis }
  | { ok: false; reason: string };

/**
 * Validates the reservation basis read back from a durable quote before it is
 * used to reserve cash. Rejects missing/negative/out-of-range values, and
 * re-derives the whole rounding chain from the pinned fee rate so a stored
 * gross/fee/reserved triple that disagrees with the canonical policy (or with
 * the quote's own limitPrice × quantity) can never be reserved against.
 *
 * The STORED values stay authoritative — they are what the user was shown;
 * the recomputation is a consistency check, not a replacement.
 */
export function validateQuotedLimitReservationBasis(input: {
  quotedFeeRate: Prisma.Decimal | null;
  quotedGrossAmount: Prisma.Decimal | null;
  quotedFeeAmount: Prisma.Decimal | null;
  quotedReservedAmount: Prisma.Decimal | null;
  limitPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
}): QuotedLimitReservationBasisResult {
  const {
    quotedFeeRate,
    quotedGrossAmount,
    quotedFeeAmount,
    quotedReservedAmount,
  } = input;

  if (
    !quotedFeeRate ||
    !quotedGrossAmount ||
    !quotedFeeAmount ||
    !quotedReservedAmount
  ) {
    return {
      ok: false,
      reason:
        'Quote is missing the pinned reservation basis (fee rate, gross, fee, reserved).',
    };
  }

  if (quotedFeeRate.lt(0) || quotedFeeRate.gt(MAX_QUOTED_FEE_RATE)) {
    return { ok: false, reason: 'Quoted fee rate is out of the valid range.' };
  }

  if (
    quotedGrossAmount.lt(0) ||
    quotedFeeAmount.lt(0) ||
    quotedReservedAmount.lt(0)
  ) {
    return { ok: false, reason: 'Quoted reservation amounts are negative.' };
  }

  if (quotedReservedAmount.lte(0)) {
    return { ok: false, reason: 'Quoted reserved amount must be positive.' };
  }

  const recomputed = calculateLimitBuyReservation({
    limitPrice: input.limitPrice,
    quantity: input.quantity,
    tradeFeeRate: quotedFeeRate,
  });

  if (
    !recomputed.grossAmount.eq(quotedGrossAmount) ||
    !recomputed.feeAmount.eq(quotedFeeAmount) ||
    !recomputed.reservedAmount.eq(quotedReservedAmount)
  ) {
    return {
      ok: false,
      reason:
        'Quoted reservation amounts do not match the canonical rounding chain.',
    };
  }

  return {
    ok: true,
    basis: {
      quotedFeeRate,
      quotedGrossAmount,
      quotedFeeAmount,
      quotedReservedAmount,
    },
  };
}

/** availableAmount = balanceAmount - reservedAmount (never stored in DB). */
export function calculateAvailableAmount(
  balanceAmount: Prisma.Decimal,
  reservedAmount: Prisma.Decimal,
): Prisma.Decimal {
  return balanceAmount.sub(reservedAmount);
}
