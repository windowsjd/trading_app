import { Prisma } from '../generated/prisma/client';
import {
  formatDecimalScale,
  formatMoneyScale8,
  returnRateScale,
} from '../fx/fx-decimal-policy';

type DecimalInput = string | Prisma.Decimal;

export type SeasonRankingSnapshotInput = {
  seasonParticipantId: string;
  totalAssetKrw: DecimalInput;
  returnRate: DecimalInput;
  capturedAt: Date;
};

export type SeasonRankingRow = {
  rank: number;
  seasonParticipantId: string;
  totalAssetKrw: string;
  returnRate: string;
};

export function buildSeasonRankingRows(
  snapshots: readonly SeasonRankingSnapshotInput[],
): SeasonRankingRow[] {
  return snapshots
    .toSorted(compareSeasonRankingSnapshots)
    .map((snapshot, index) => ({
      rank: index + 1,
      seasonParticipantId: snapshot.seasonParticipantId,
      totalAssetKrw: formatMoneyScale8(snapshot.totalAssetKrw),
      returnRate: formatDecimalScale(snapshot.returnRate, returnRateScale),
    }));
}

export function compareSeasonRankingSnapshots(
  a: SeasonRankingSnapshotInput,
  b: SeasonRankingSnapshotInput,
): number {
  const totalAssetDiff = toDecimal(b.totalAssetKrw).cmp(
    toDecimal(a.totalAssetKrw),
  );
  if (totalAssetDiff !== 0) {
    return totalAssetDiff;
  }

  const returnRateDiff = toDecimal(b.returnRate).cmp(toDecimal(a.returnRate));
  if (returnRateDiff !== 0) {
    return returnRateDiff;
  }

  return (
    a.capturedAt.getTime() - b.capturedAt.getTime() ||
    a.seasonParticipantId.localeCompare(b.seasonParticipantId)
  );
}

function toDecimal(value: DecimalInput): Prisma.Decimal {
  return typeof value === 'string' ? new Prisma.Decimal(value.trim()) : value;
}
