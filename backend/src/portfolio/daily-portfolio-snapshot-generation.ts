import { Prisma } from '../generated/prisma/client';
import { PortfolioValuationResult } from './portfolio-valuation.policy';
import { requireSeasonSnapshotParticipantId } from './season-snapshot-scope';

/**
 * This writer is the SEASON daily-snapshot path. General-mode daily snapshots
 * are written by GeneralAccountPerformanceService instead, because they carry
 * time-weighted performance columns this shape does not have.
 */
function requireSeasonValuationParticipantId(
  valuation: PortfolioValuationResult,
): string {
  return requireSeasonSnapshotParticipantId(valuation.seasonParticipantId);
}

export type DailyPortfolioSnapshotWriteInput = {
  valuation: PortfolioValuationResult;
  snapshotDate: Date;
  capturedAt: Date;
  dryRun: boolean;
  /**
   * The participant's verified trading account (작업 7 dual-write). Season
   * writers MUST supply it; a null link is a caller-side integrity failure,
   * never a reason to write an unscoped snapshot.
   */
  tradingAccountId: string;
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
  tradingAccountId: string;
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
      seasonParticipantId: string | null;
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
        seasonParticipantId: requireSeasonValuationParticipantId(
          input.valuation,
        ),
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
    seasonParticipantId: requireSeasonSnapshotParticipantId(
      row.seasonParticipantId,
    ),
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
    seasonParticipantId: requireSeasonValuationParticipantId(input.valuation),
    tradingAccountId: input.tradingAccountId,
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
    seasonParticipantId: requireSeasonValuationParticipantId(valuation),
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
