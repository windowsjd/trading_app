import {
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';

export const fxExecuteSnapshotFreshnessThresholdMs = 60_000;

export const allowedFxExecuteSourceTypes = [
  FxRateSourceType.admin_manual,
] as const;

export type AllowedFxExecuteSourceType =
  (typeof allowedFxExecuteSourceTypes)[number];

export type FxExecuteSnapshotCandidate = {
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  sourceType: FxRateSourceType;
  rate: string | Prisma.Decimal;
  effectiveAt: Date;
  capturedAt: Date;
  createdAt: Date;
};

export function isAllowedExecuteSourceType(
  sourceType: unknown,
): sourceType is AllowedFxExecuteSourceType {
  return allowedFxExecuteSourceTypes.includes(
    sourceType as AllowedFxExecuteSourceType,
  );
}

export function isFutureSnapshot(
  effectiveAt: Date,
  executeNow: Date,
): boolean {
  return effectiveAt.getTime() > executeNow.getTime();
}

export function isFxSnapshotStale(
  effectiveAt: Date,
  executeNow: Date,
): boolean {
  if (isFutureSnapshot(effectiveAt, executeNow)) {
    return false;
  }

  return (
    executeNow.getTime() - effectiveAt.getTime() >
    fxExecuteSnapshotFreshnessThresholdMs
  );
}

export function compareFxSnapshotsForExecute(
  a: Pick<FxExecuteSnapshotCandidate, 'effectiveAt' | 'capturedAt' | 'createdAt'>,
  b: Pick<FxExecuteSnapshotCandidate, 'effectiveAt' | 'capturedAt' | 'createdAt'>,
): number {
  return (
    b.effectiveAt.getTime() - a.effectiveAt.getTime() ||
    b.capturedAt.getTime() - a.capturedAt.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime()
  );
}

export function selectEligibleFxSnapshotForExecute<
  T extends FxExecuteSnapshotCandidate,
>(snapshots: readonly T[], executeNow: Date): T | null {
  return (
    snapshots
      .filter((snapshot) => isEligibleFxSnapshotForExecute(snapshot, executeNow))
      .toSorted(compareFxSnapshotsForExecute)
      .at(0) ?? null
  );
}

function isEligibleFxSnapshotForExecute(
  snapshot: FxExecuteSnapshotCandidate,
  executeNow: Date,
): boolean {
  return (
    snapshot.baseCurrency === CurrencyCode.USD &&
    snapshot.quoteCurrency === CurrencyCode.KRW &&
    isAllowedExecuteSourceType(snapshot.sourceType) &&
    !isFutureSnapshot(snapshot.effectiveAt, executeNow) &&
    isPositiveRate(snapshot.rate)
  );
}

function isPositiveRate(rate: string | Prisma.Decimal): boolean {
  try {
    const decimal =
      typeof rate === 'string' ? new Prisma.Decimal(rate.trim()) : rate;

    return decimal.isFinite() && decimal.gt(0);
  } catch {
    return false;
  }
}
