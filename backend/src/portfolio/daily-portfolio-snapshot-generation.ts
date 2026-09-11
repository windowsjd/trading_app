import { Prisma } from '../generated/prisma/client';
import { PortfolioValuationResult } from './portfolio-valuation.policy';

/**
 * This writer is the SEASON daily-snapshot path. General-mode daily snapshots
 * are written by GeneralAccountPerformanceService instead, because they carry
 * time-weighted performance columns this shape does not have.
 */
function requireSeasonValuationParticipantId(
  valuation: PortfolioValuationResult,
): string {
  if (!valuation.seasonParticipantId) {
    throw new Error('Season valuation has no participant context.');
  }
  return valuation.seasonParticipantId;
}

export type DailyPortfolioSnapshotWriteInput = {
  valuation: PortfolioValuationResult;
  snapshotDate: Date;
  capturedAt: Date;
  dryRun: boolean;
  /**
   * The participant's verified trading account, which is the snapshot's only
   * persisted ownership key. Season writers must supply it.
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
      tradingAccountId: string;
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

  const seasonParticipantId = requireSeasonValuationParticipantId(
    input.valuation,
  );

  const data = buildDailyPortfolioSnapshotData(input);
  const canonicalUpdate = {
    totalAssetKrw: data.totalAssetKrw,
    returnRate: data.returnRate,
    krwCash: data.krwCash,
    usdCashKrw: data.usdCashKrw,
    assetValueKrw: data.assetValueKrw,
    realizedPnlKrw: data.realizedPnlKrw,
    unrealizedPnlKrw: data.unrealizedPnlKrw,
    capturedAt: data.capturedAt,
  };
  const row = await prisma.dailyPortfolioSnapshot.upsert({
    where: {
      tradingAccountId_snapshotDate: {
        tradingAccountId: input.tradingAccountId,
        snapshotDate: input.snapshotDate,
      },
    },
    create: data,
    // An ordinary rerun may refresh snapshot values for this account/date.
    update: canonicalUpdate,
    select: {
      tradingAccountId: true,
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

  if (row.tradingAccountId !== input.tradingAccountId) {
    throw new Error('Daily portfolio snapshot account scope changed.');
  }

  return {
    seasonParticipantId,
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
