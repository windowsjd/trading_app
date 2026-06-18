import { Prisma } from '../generated/prisma/client';
import {
  formatDecimalScale,
  formatMoneyScale8,
  returnRateScale,
} from '../fx/fx-decimal-policy';

type DecimalInput = string | Prisma.Decimal;

export type RankingSnapshotInput = {
  seasonParticipantId: string;
  userId: string;
  snapshotDate: Date;
  totalAssetKrw: DecimalInput;
  returnRate: DecimalInput;
  capturedAt: Date;
  createdAt?: Date | null;
};

export type RankingHistoricalSnapshotInput = Omit<
  RankingSnapshotInput,
  'userId'
> & {
  userId?: string;
};

export type RankingExecutedOrderInput = {
  seasonParticipantId: string;
  executedAt: Date | null;
};

export type RankingCalculatedRow = {
  rank: number;
  seasonParticipantId: string;
  userId: string;
  totalAssetKrw: string;
  returnRate: string;
  maxDrawdown: string;
  totalFillCount: number;
  reachedReturnAt: Date;
};

type RankingComparableRow = {
  seasonParticipantId: string;
  userId: string;
  returnRate: DecimalInput;
  maxDrawdown: DecimalInput;
  totalFillCount: number;
  reachedReturnAt: Date | null;
};

const ZERO_DECIMAL = new Prisma.Decimal(0);

export function buildRankingRowsForSnapshots(input: {
  rankingSnapshots: readonly RankingSnapshotInput[];
  historicalSnapshots: readonly RankingHistoricalSnapshotInput[];
  executedOrders: readonly RankingExecutedOrderInput[];
}): RankingCalculatedRow[] {
  const snapshotsByParticipant = groupByParticipant(input.historicalSnapshots);
  const ordersByParticipant = groupByParticipant(input.executedOrders);

  const rows = input.rankingSnapshots.map((snapshot) => {
    const participantSnapshots = selectSnapshotsThroughBasis(
      snapshotsByParticipant.get(snapshot.seasonParticipantId) ?? [],
      snapshot,
    );
    const rankingHistory =
      participantSnapshots.length > 0 ? participantSnapshots : [snapshot];
    const targetReturnRate = toDecimal(snapshot.returnRate);
    const reachedReturnAt = calculateReachedReturnAt(
      rankingHistory,
      targetReturnRate,
      snapshot.capturedAt,
    );

    return {
      seasonParticipantId: snapshot.seasonParticipantId,
      userId: snapshot.userId,
      totalAssetKrw: formatMoneyScale8(snapshot.totalAssetKrw),
      returnRate: formatDecimalScale(snapshot.returnRate, returnRateScale),
      maxDrawdown: formatDecimalScale(
        calculateMaxDrawdownPercent(rankingHistory),
        returnRateScale,
      ),
      totalFillCount: calculateTotalFillCount(
        ordersByParticipant.get(snapshot.seasonParticipantId) ?? [],
        snapshot.capturedAt,
      ),
      reachedReturnAt,
    };
  });

  return assignSequentialRanks(rows.toSorted(compareRankingRows));
}

export function calculateMaxDrawdownPercent(
  snapshots: readonly RankingHistoricalSnapshotInput[],
): Prisma.Decimal {
  const sortedSnapshots = sortSnapshots(snapshots);
  if (sortedSnapshots.length <= 1) {
    return ZERO_DECIMAL;
  }

  let runningPeak: Prisma.Decimal | null = null;
  let maxDrawdown = ZERO_DECIMAL;

  for (const snapshot of sortedSnapshots) {
    const totalAssetKrw = toDecimal(snapshot.totalAssetKrw);
    if (runningPeak === null || totalAssetKrw.gt(runningPeak)) {
      runningPeak = totalAssetKrw;
    }

    if (runningPeak.lte(0)) {
      continue;
    }

    const currentDrawdown = runningPeak
      .sub(totalAssetKrw)
      .div(runningPeak)
      .mul(100);
    if (currentDrawdown.gt(maxDrawdown)) {
      maxDrawdown = currentDrawdown;
    }
  }

  return maxDrawdown;
}

export function calculateReachedReturnAt(
  snapshots: readonly Pick<
    RankingHistoricalSnapshotInput,
    'snapshotDate' | 'returnRate' | 'capturedAt' | 'createdAt'
  >[],
  targetReturnRate: DecimalInput,
  fallbackCapturedAt: Date,
): Date {
  const target = toDecimal(targetReturnRate);
  const reachedSnapshot = sortSnapshots(snapshots).find((snapshot) =>
    toDecimal(snapshot.returnRate).gte(target),
  );

  return reachedSnapshot?.capturedAt ?? fallbackCapturedAt;
}

export function calculateTotalFillCount(
  orders: readonly RankingExecutedOrderInput[],
  cutoff: Date,
): number {
  return orders.filter(
    (order) =>
      order.executedAt !== null &&
      order.executedAt.getTime() <= cutoff.getTime(),
  ).length;
}

export function compareRankingRows(
  left: RankingComparableRow,
  right: RankingComparableRow,
): number {
  const returnRateDiff = toDecimal(right.returnRate).cmp(
    toDecimal(left.returnRate),
  );
  if (returnRateDiff !== 0) {
    return returnRateDiff;
  }

  const maxDrawdownDiff = toDecimal(left.maxDrawdown).cmp(
    toDecimal(right.maxDrawdown),
  );
  if (maxDrawdownDiff !== 0) {
    return maxDrawdownDiff;
  }

  const fillCountDiff = left.totalFillCount - right.totalFillCount;
  if (fillCountDiff !== 0) {
    return fillCountDiff;
  }

  const reachedReturnAtDiff = compareNullableDates(
    left.reachedReturnAt,
    right.reachedReturnAt,
  );
  if (reachedReturnAtDiff !== 0) {
    return reachedReturnAtDiff;
  }

  return (
    left.userId.localeCompare(right.userId) ||
    left.seasonParticipantId.localeCompare(right.seasonParticipantId)
  );
}

export function assignSequentialRanks<T extends object>(
  rows: readonly T[],
): Array<T & { rank: number }> {
  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
  }));
}

function selectSnapshotsThroughBasis(
  snapshots: readonly RankingHistoricalSnapshotInput[],
  basis: RankingSnapshotInput,
): RankingHistoricalSnapshotInput[] {
  return sortSnapshots(snapshots).filter((snapshot) => {
    const snapshotDateTime = snapshot.snapshotDate.getTime();
    const basisDateTime = basis.snapshotDate.getTime();

    if (snapshotDateTime < basisDateTime) {
      return true;
    }

    if (snapshotDateTime > basisDateTime) {
      return false;
    }

    return snapshot.capturedAt.getTime() <= basis.capturedAt.getTime();
  });
}

function sortSnapshots<
  T extends {
    snapshotDate: Date;
    capturedAt: Date;
    createdAt?: Date | null;
  },
>(snapshots: readonly T[]): T[] {
  return snapshots.toSorted(
    (left, right) =>
      left.snapshotDate.getTime() - right.snapshotDate.getTime() ||
      left.capturedAt.getTime() - right.capturedAt.getTime() ||
      (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0),
  );
}

function groupByParticipant<
  T extends {
    seasonParticipantId: string;
  },
>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const item of items) {
    const existing = grouped.get(item.seasonParticipantId);
    if (existing) {
      existing.push(item);
      continue;
    }

    grouped.set(item.seasonParticipantId, [item]);
  }

  return grouped;
}

function compareNullableDates(left: Date | null, right: Date | null): number {
  if (left && right) {
    return left.getTime() - right.getTime();
  }

  if (left) {
    return -1;
  }

  if (right) {
    return 1;
  }

  return 0;
}

function toDecimal(value: DecimalInput): Prisma.Decimal {
  return typeof value === 'string' ? new Prisma.Decimal(value.trim()) : value;
}
