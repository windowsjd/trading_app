import { CurrencyCode, Prisma } from '../generated/prisma/client';
import {
  calculateFeeAmount,
  calculateGrossTargetAmount,
  calculateNetTargetAmount,
  formatFeeRateScale6,
  formatMoneyScale8,
  formatRateScale8,
  parseDecimalString,
} from './fx-decimal-policy';
import {
  fxExecuteErrorCodes,
  type FxExecuteErrorCode,
} from './fx-execute-error-policy';
import type {
  FxExecuteCurrency,
  NormalizedFxExecuteRequest,
} from './fx-execute-request-policy';
import {
  isFxSnapshotStale,
  selectEligibleFxSnapshotForExecute,
  type FxExecuteSnapshotCandidate,
} from './fx-execute-snapshot-policy';

type DecimalInput = string | Prisma.Decimal;

export type FxExecuteWalletCandidate = {
  id: string;
  seasonParticipantId: string;
  currencyCode: FxExecuteCurrency;
  balanceAmount: DecimalInput;
};

export type FxExecuteSnapshotWithId = FxExecuteSnapshotCandidate & {
  id: string;
};

export type FxExecutePlanInput = {
  request: NormalizedFxExecuteRequest;
  sourceWallet: FxExecuteWalletCandidate | null;
  targetWallet: FxExecuteWalletCandidate | null;
  snapshots: readonly FxExecuteSnapshotWithId[];
  fxFeeRate: DecimalInput;
  executeNow: Date;
};

export type FxExecutePlan = {
  userId: string;
  seasonParticipantId: string;
  fromCurrency: FxExecuteCurrency;
  toCurrency: FxExecuteCurrency;
  sourceWalletId: string;
  targetWalletId: string;
  sourceAmount: string;
  grossTargetAmount: string;
  feeRate: string;
  feeAmount: string;
  feeCurrency: FxExecuteCurrency;
  appliedRate: string;
  netTargetAmount: string;
  targetCreditAmount: string;
  sourceDebitAmount: string;
  fxRateSnapshotId: string;
  rateCapturedAt: Date;
  rateEffectiveAt: Date;
  requestHash: string;
  idempotencyKey: string;
};

export type FxExecutePlanResult =
  | { ok: true; value: FxExecutePlan }
  | { ok: false; errorCode: FxExecuteErrorCode };

export function buildFxExecutePlan(
  input: FxExecutePlanInput,
): FxExecutePlanResult {
  const { request, sourceWallet, targetWallet, executeNow } = input;

  if (
    !isMatchingWallet(
      sourceWallet,
      request.seasonParticipantId,
      request.fromCurrency,
    )
  ) {
    return {
      ok: false,
      errorCode: fxExecuteErrorCodes.SOURCE_WALLET_NOT_FOUND,
    };
  }

  if (
    !isMatchingWallet(
      targetWallet,
      request.seasonParticipantId,
      request.toCurrency,
    )
  ) {
    return {
      ok: false,
      errorCode: fxExecuteErrorCodes.TARGET_WALLET_NOT_FOUND,
    };
  }

  const selectedSnapshot = selectEligibleFxSnapshotForExecute(
    input.snapshots,
    executeNow,
  );

  if (!selectedSnapshot) {
    return {
      ok: false,
      errorCode: fxExecuteErrorCodes.FX_RATE_UNAVAILABLE,
    };
  }

  if (isFxSnapshotStale(selectedSnapshot.effectiveAt, executeNow)) {
    return {
      ok: false,
      errorCode: fxExecuteErrorCodes.FX_RATE_STALE,
    };
  }

  const sourceWalletBalance = parseFiniteDecimalInput(
    sourceWallet.balanceAmount,
    'sourceWallet.balanceAmount',
  );
  const sourceAmount = formatMoneyScale8(request.sourceAmount);
  const appliedRate = formatRateScale8(selectedSnapshot.rate);
  const feeRate = formatFeeRateScale6(input.fxFeeRate);
  const grossTargetAmount = calculateGrossTargetAmount({
    fromCurrency: toCurrencyCode(request.fromCurrency),
    toCurrency: toCurrencyCode(request.toCurrency),
    sourceAmount,
    appliedRate,
  });
  const feeAmount = calculateFeeAmount({
    grossTargetAmount,
    feeRate,
  });
  const netTargetAmount = calculateNetTargetAmount({
    grossTargetAmount,
    feeAmount,
  });

  if (sourceWalletBalance.lt(sourceAmount)) {
    return {
      ok: false,
      errorCode: fxExecuteErrorCodes.INSUFFICIENT_BALANCE,
    };
  }

  return {
    ok: true,
    value: {
      userId: request.userId,
      seasonParticipantId: request.seasonParticipantId,
      fromCurrency: request.fromCurrency,
      toCurrency: request.toCurrency,
      sourceWalletId: sourceWallet.id,
      targetWalletId: targetWallet.id,
      sourceAmount,
      grossTargetAmount,
      feeRate,
      feeAmount,
      feeCurrency: request.toCurrency,
      appliedRate,
      netTargetAmount,
      targetCreditAmount: netTargetAmount,
      sourceDebitAmount: sourceAmount,
      fxRateSnapshotId: selectedSnapshot.id,
      rateCapturedAt: selectedSnapshot.capturedAt,
      rateEffectiveAt: selectedSnapshot.effectiveAt,
      requestHash: request.requestHash,
      idempotencyKey: request.idempotencyKey,
    },
  };
}

function isMatchingWallet(
  wallet: FxExecuteWalletCandidate | null,
  seasonParticipantId: string,
  currencyCode: FxExecuteCurrency,
): wallet is FxExecuteWalletCandidate {
  return (
    wallet !== null &&
    wallet.seasonParticipantId === seasonParticipantId &&
    wallet.currencyCode === currencyCode
  );
}

function parseFiniteDecimalInput(
  value: DecimalInput,
  fieldName: string,
): Prisma.Decimal {
  if (typeof value === 'string') {
    try {
      return parseDecimalString(value);
    } catch {
      throw new Error(`${fieldName} must be a finite decimal`);
    }
  }

  if (value instanceof Prisma.Decimal && value.isFinite()) {
    return value;
  }

  throw new Error(`${fieldName} must be a finite decimal`);
}

function toCurrencyCode(currency: FxExecuteCurrency): CurrencyCode {
  return currency === 'KRW' ? CurrencyCode.KRW : CurrencyCode.USD;
}
