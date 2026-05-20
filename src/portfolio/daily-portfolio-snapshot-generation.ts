import { Prisma } from '../generated/prisma/client';
import { PortfolioValuationResult } from './portfolio-valuation.policy';

export type DailyPortfolioSnapshotWriteInput = {
  valuation: PortfolioValuationResult;
  snapshotDate: Date;
  capturedAt: Date;
  dryRun: boolean;
};

export type DailyPortfolioSnapshotWriteResult = {
  seasonParticipantId: string;
  totalAssetKrw: string;
  returnRate: string;
  krwCash: string;
  usdCashKrw: string;
  assetValueKrw: string;
  realizedPnlKrw: string;
  unrealizedPnlKrw: string;
  capturedAt: string;
  dryRun: boolean;
};

export type DailyPortfolioSnapshotPersistenceData = {
  seasonParticipantId: string;
  snapshotDate: Date;
  totalAssetKrw: string;
  returnRate: string;
  krwCash: string;
  usdCashKrw: string;
  assetValueKrw: string;
  realizedPnlKrw: string;
  unrealizedPnlKrw: string;
  capturedAt: Date;
};

type DailyPortfolioSnapshotWriter = {
  dailyPortfolioSnapshot: {
    upsert: (args: unknown) => Promise<{
      seasonParticipantId: string;
      totalAssetKrw: Prisma.Decimal;
      returnRate: Prisma.Decimal;
      krwCash: Prisma.Decimal;
      usdCashKrw: Prisma.Decimal;
      assetValueKrw: Prisma.Decimal;
      realizedPnlKrw: Prisma.Decimal;
      unrealizedPnlKrw: Prisma.Decimal;
      capturedAt: Date;
    }>;
  };
};

export async function writeDailyPortfolioSnapshot(
  prisma: DailyPortfolioSnapshotWriter,
  input: DailyPortfolioSnapshotWriteInput,
): Promise<DailyPortfolioSnapshotWriteResult> {
  if (input.dryRun) {
    return toWriteResult(input.valuation, input.capturedAt, true);
  }

  const row = await prisma.dailyPortfolioSnapshot.upsert({
    where: {
      seasonParticipantId_snapshotDate: {
        seasonParticipantId: input.valuation.seasonParticipantId,
        snapshotDate: input.snapshotDate,
      },
    },
    create: buildDailyPortfolioSnapshotData(input),
    update: buildDailyPortfolioSnapshotData(input),
    select: {
      seasonParticipantId: true,
      totalAssetKrw: true,
      returnRate: true,
      krwCash: true,
      usdCashKrw: true,
      assetValueKrw: true,
      realizedPnlKrw: true,
      unrealizedPnlKrw: true,
      capturedAt: true,
    },
  });

  return {
    seasonParticipantId: row.seasonParticipantId,
    totalAssetKrw: row.totalAssetKrw.toFixed(8),
    returnRate: row.returnRate.toFixed(8),
    krwCash: row.krwCash.toFixed(8),
    usdCashKrw: row.usdCashKrw.toFixed(8),
    assetValueKrw: row.assetValueKrw.toFixed(8),
    realizedPnlKrw: row.realizedPnlKrw.toFixed(8),
    unrealizedPnlKrw: row.unrealizedPnlKrw.toFixed(8),
    capturedAt: row.capturedAt.toISOString(),
    dryRun: false,
  };
}

export function buildDailyPortfolioSnapshotData(
  input: DailyPortfolioSnapshotWriteInput,
): DailyPortfolioSnapshotPersistenceData {
  return {
    seasonParticipantId: input.valuation.seasonParticipantId,
    snapshotDate: input.snapshotDate,
    totalAssetKrw: input.valuation.totalAssetKrw,
    returnRate: input.valuation.returnRate,
    krwCash: input.valuation.krwCash,
    usdCashKrw: input.valuation.usdCashKrw,
    assetValueKrw: input.valuation.assetValueKrw,
    realizedPnlKrw: input.valuation.realizedPnlKrw,
    unrealizedPnlKrw: input.valuation.unrealizedPnlKrw,
    capturedAt: input.capturedAt,
  };
}

function toWriteResult(
  valuation: PortfolioValuationResult,
  capturedAt: Date,
  dryRun: boolean,
): DailyPortfolioSnapshotWriteResult {
  return {
    seasonParticipantId: valuation.seasonParticipantId,
    totalAssetKrw: valuation.totalAssetKrw,
    returnRate: valuation.returnRate,
    krwCash: valuation.krwCash,
    usdCashKrw: valuation.usdCashKrw,
    assetValueKrw: valuation.assetValueKrw,
    realizedPnlKrw: valuation.realizedPnlKrw,
    unrealizedPnlKrw: valuation.unrealizedPnlKrw,
    capturedAt: capturedAt.toISOString(),
    dryRun,
  };
}
