import { Prisma } from '../generated/prisma/client';

/**
 * Time-weighted return (TWR) for general-mode accounts — a PURE policy
 * (작업 7).
 *
 * WHY TWR AND NOT A SIMPLE RATIO
 * ------------------------------
 * General accounts receive external virtual funding after opening (rewarded
 * ads). A simple
 *     (totalAsset - cumulativeExternalFunding) / cumulativeExternalFunding
 * moves the headline return the instant money arrives — watching an ad would
 * change a user's "investment performance" without a single trade. TWR
 * removes that by chaining per-segment growth factors and treating each
 * inflow as a segment boundary that contributes a factor of exactly 1.
 *
 * factor is the SOURCE OF TRUTH. returnRate is a rounded presentation of it
 * and is NEVER fed back into the next segment — rounding to 8 dp on every
 * snapshot would compound into visible drift.
 *
 * Everything is Prisma.Decimal end to end. A JS number anywhere in this file
 * would silently lose precision on realistic KRW amounts.
 */

export const TWR_FACTOR_SCALE = 18;
/** Matches EquitySnapshot.returnRate / DailyPortfolioSnapshot.returnRate. */
export const RETURN_RATE_SCALE = 8;
/** Matches the Decimal(24,8) money columns. */
export const MONEY_SCALE = 8;

export const INITIAL_TWR_FACTOR = new Prisma.Decimal(1);

export class GeneralPerformanceError extends Error {
  constructor(
    readonly code: GeneralPerformanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GeneralPerformanceError';
  }
}

export const generalPerformanceErrorCodes = {
  /** No origin snapshot exists; the account was never initialized. */
  GENERAL_PERFORMANCE_NOT_INITIALIZED: 'GENERAL_PERFORMANCE_NOT_INITIALIZED',
  /** Stored performance state is self-inconsistent. */
  GENERAL_PERFORMANCE_INTEGRITY: 'GENERAL_PERFORMANCE_INTEGRITY',
  /** Value reappeared from zero with no external-funding boundary. */
  GENERAL_PERFORMANCE_DISCONTINUITY: 'GENERAL_PERFORMANCE_DISCONTINUITY',
} as const;

export type GeneralPerformanceErrorCode =
  (typeof generalPerformanceErrorCodes)[keyof typeof generalPerformanceErrorCodes];

/** The performance state carried by one snapshot. */
export type GeneralPerformanceState = {
  totalAssetKrw: Prisma.Decimal;
  cumulativeExternalFundingKrw: Prisma.Decimal;
  investmentPnlKrw: Prisma.Decimal;
  timeWeightedReturnFactor: Prisma.Decimal;
};

export type GeneralPerformanceAdvance = GeneralPerformanceState & {
  /** (factor - 1) * 100, rounded to the snapshot column scale. */
  returnRate: Prisma.Decimal;
};

function assertFinite(value: Prisma.Decimal, label: string): void {
  if (!value.isFinite()) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      `${label} is not a finite decimal.`,
    );
  }
}

/** (factor - 1) * 100, at the snapshot column's scale. */
export function toReturnRatePercent(factor: Prisma.Decimal): Prisma.Decimal {
  assertFinite(factor, 'timeWeightedReturnFactor');
  return factor
    .sub(1)
    .mul(100)
    .toDecimalPlaces(RETURN_RATE_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

/** The origin state of a brand-new general account: nothing earned yet. */
export function buildGeneralPerformanceOrigin(
  initialFundingKrw: Prisma.Decimal | string,
): GeneralPerformanceAdvance {
  const funding = new Prisma.Decimal(initialFundingKrw);
  assertFinite(funding, 'initialFundingKrw');
  if (funding.lt(0)) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      'Initial funding cannot be negative.',
    );
  }

  return {
    totalAssetKrw: funding,
    cumulativeExternalFundingKrw: funding,
    investmentPnlKrw: new Prisma.Decimal(0),
    timeWeightedReturnFactor: INITIAL_TWR_FACTOR,
    returnRate: new Prisma.Decimal(0),
  };
}

/**
 * Advance the factor across ONE ordinary segment — no external funding in
 * between, so the whole change is market performance.
 *
 *     factor = previousFactor × (currentTotal / previousTotal)
 *
 * Chaining N ordinary advances must equal one advance over the same span,
 * which is exactly what multiplication gives.
 */
export function advanceGeneralPerformance(input: {
  previous: Pick<
    GeneralPerformanceState,
    'totalAssetKrw' | 'timeWeightedReturnFactor'
  >;
  currentTotalAssetKrw: Prisma.Decimal | string;
  cumulativeExternalFundingKrw: Prisma.Decimal | string;
}): GeneralPerformanceAdvance {
  const previousTotal = new Prisma.Decimal(input.previous.totalAssetKrw);
  const previousFactor = new Prisma.Decimal(
    input.previous.timeWeightedReturnFactor,
  );
  const currentTotal = new Prisma.Decimal(input.currentTotalAssetKrw);
  const cumulativeExternalFundingKrw = new Prisma.Decimal(
    input.cumulativeExternalFundingKrw,
  );

  assertFinite(previousTotal, 'previous.totalAssetKrw');
  assertFinite(previousFactor, 'previous.timeWeightedReturnFactor');
  assertFinite(currentTotal, 'currentTotalAssetKrw');
  assertFinite(cumulativeExternalFundingKrw, 'cumulativeExternalFundingKrw');

  // No leverage, no loans, no negative cash: a negative total is corruption,
  // not a legitimate state to render.
  if (currentTotal.lt(0) || previousTotal.lt(0)) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      'Total asset value cannot be negative.',
    );
  }
  if (previousFactor.lt(0)) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      'Time-weighted return factor cannot be negative.',
    );
  }

  let factor: Prisma.Decimal;
  if (previousTotal.isZero()) {
    if (currentTotal.isZero()) {
      // Still wiped out: the cumulative factor simply stands still.
      factor = previousFactor;
    } else {
      // Value cannot reappear from nothing without an external-funding
      // boundary. Silently re-basing here would erase a total loss from the
      // user's cumulative return, so it fails closed instead.
      throw new GeneralPerformanceError(
        generalPerformanceErrorCodes.GENERAL_PERFORMANCE_DISCONTINUITY,
        'Total asset value grew from zero without an external funding boundary; performance history cannot be continued automatically.',
      );
    }
  } else {
    factor = previousFactor
      .mul(currentTotal)
      .div(previousTotal)
      .toDecimalPlaces(TWR_FACTOR_SCALE, Prisma.Decimal.ROUND_HALF_UP);
  }

  return {
    totalAssetKrw: currentTotal,
    cumulativeExternalFundingKrw,
    investmentPnlKrw: currentTotal.sub(cumulativeExternalFundingKrw),
    timeWeightedReturnFactor: factor,
    returnRate: toReturnRatePercent(factor),
  };
}

/**
 * The two states bracketing an external virtual-funding inflow.
 *
 * BEFORE absorbs all market performance up to the instant of the inflow.
 * AFTER adds the money to the total and to cumulative external funding, and
 * changes NOTHING else — same investment PnL, same factor, same return rate.
 * That equality is what makes an ad reward performance-neutral, and the
 * integration tests assert it directly.
 */
export function buildExternalFundingBoundary(input: {
  previous: Pick<
    GeneralPerformanceState,
    'totalAssetKrw' | 'timeWeightedReturnFactor'
  >;
  /** Valuation taken immediately BEFORE the money is credited. */
  totalAssetBeforeKrw: Prisma.Decimal | string;
  /** Cumulative external funding BEFORE this inflow. */
  cumulativeExternalFundingBeforeKrw: Prisma.Decimal | string;
  externalFundingAmountKrw: Prisma.Decimal | string;
}): { before: GeneralPerformanceAdvance; after: GeneralPerformanceAdvance } {
  const amount = new Prisma.Decimal(input.externalFundingAmountKrw);
  assertFinite(amount, 'externalFundingAmountKrw');
  if (amount.lte(0)) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      'External funding amount must be greater than zero.',
    );
  }

  const before = advanceGeneralPerformance({
    previous: input.previous,
    currentTotalAssetKrw: input.totalAssetBeforeKrw,
    cumulativeExternalFundingKrw: input.cumulativeExternalFundingBeforeKrw,
  });

  const after: GeneralPerformanceAdvance = {
    totalAssetKrw: before.totalAssetKrw.add(amount),
    cumulativeExternalFundingKrw:
      before.cumulativeExternalFundingKrw.add(amount),
    // Unchanged by construction — the inflow is not a gain.
    investmentPnlKrw: before.investmentPnlKrw,
    timeWeightedReturnFactor: before.timeWeightedReturnFactor,
    returnRate: before.returnRate,
  };

  return { before, after };
}

/**
 * Structural check of one stored performance state. Used before trusting a
 * snapshot as the basis for the next advance, and by the audit script.
 */
export function assertGeneralPerformanceStateConsistent(
  state: {
    totalAssetKrw: Prisma.Decimal;
    cumulativeExternalFundingKrw: Prisma.Decimal | null;
    investmentPnlKrw: Prisma.Decimal | null;
    timeWeightedReturnFactor: Prisma.Decimal | null;
    returnRate: Prisma.Decimal;
  },
  label: string,
): GeneralPerformanceState {
  if (
    state.cumulativeExternalFundingKrw === null ||
    state.investmentPnlKrw === null ||
    state.timeWeightedReturnFactor === null
  ) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      `${label} is missing general performance values.`,
    );
  }

  if (state.totalAssetKrw.lt(0)) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      `${label} has a negative total asset value.`,
    );
  }
  if (state.cumulativeExternalFundingKrw.lt(0)) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      `${label} has negative cumulative external funding.`,
    );
  }
  if (state.timeWeightedReturnFactor.lt(0)) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      `${label} has a negative time-weighted return factor.`,
    );
  }

  const expectedPnl = state.totalAssetKrw.sub(
    state.cumulativeExternalFundingKrw,
  );
  if (
    !state.investmentPnlKrw
      .toDecimalPlaces(MONEY_SCALE)
      .equals(expectedPnl.toDecimalPlaces(MONEY_SCALE))
  ) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      `${label} investment PnL does not equal totalAsset - cumulativeExternalFunding.`,
    );
  }

  const expectedReturnRate = toReturnRatePercent(
    state.timeWeightedReturnFactor,
  );
  if (
    !state.returnRate
      .toDecimalPlaces(RETURN_RATE_SCALE)
      .equals(expectedReturnRate)
  ) {
    throw new GeneralPerformanceError(
      generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
      `${label} return rate does not match its time-weighted return factor.`,
    );
  }

  return {
    totalAssetKrw: state.totalAssetKrw,
    cumulativeExternalFundingKrw: state.cumulativeExternalFundingKrw,
    investmentPnlKrw: state.investmentPnlKrw,
    timeWeightedReturnFactor: state.timeWeightedReturnFactor,
  };
}

/** Formats a performance state for snapshot columns / API responses. */
export function formatGeneralPerformance(advance: GeneralPerformanceAdvance) {
  return {
    totalAssetKrw: advance.totalAssetKrw.toFixed(MONEY_SCALE),
    cumulativeExternalFundingKrw:
      advance.cumulativeExternalFundingKrw.toFixed(MONEY_SCALE),
    investmentPnlKrw: advance.investmentPnlKrw.toFixed(MONEY_SCALE),
    timeWeightedReturnFactor:
      advance.timeWeightedReturnFactor.toFixed(TWR_FACTOR_SCALE),
    returnRate: advance.returnRate.toFixed(RETURN_RATE_SCALE),
  };
}
