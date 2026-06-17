import { SeasonRankingType } from '../generated/prisma/client';
import { SeasonRankingRow } from './portfolio-ranking.policy';

export type SeasonRankingWriteInput = {
  seasonId: string;
  rankType: SeasonRankingType;
  rankingDate: Date;
  capturedAt: Date;
  rows: readonly SeasonRankingRow[];
  dryRun: boolean;
};

export type SeasonRankingWriteResult = SeasonRankingRow & {
  dryRun: boolean;
};

type SeasonRankingWriter = {
  $transaction: <T>(
    callback: (tx: SeasonRankingTransaction) => Promise<T>,
  ) => Promise<T>;
};

type SeasonRankingTransaction = {
  seasonRanking: {
    findMany: (args: unknown) => Promise<
      Array<{
        seasonParticipantId: string;
      }>
    >;
    update: (args: unknown) => Promise<unknown>;
    upsert: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
};

export async function writeSeasonRankings(
  prisma: SeasonRankingWriter,
  input: SeasonRankingWriteInput,
): Promise<SeasonRankingWriteResult[]> {
  if (input.dryRun) {
    return input.rows.map((row) => ({
      ...row,
      dryRun: true,
    }));
  }

  await prisma.$transaction(async (tx) => {
    const existingRows = await tx.seasonRanking.findMany({
      where: {
        seasonId: input.seasonId,
        rankType: input.rankType,
        rankingDate: input.rankingDate,
      },
      select: {
        seasonParticipantId: true,
      },
    });

    for (const [index, row] of existingRows.entries()) {
      await tx.seasonRanking.update({
        where: participantRankingWhere(input, row.seasonParticipantId),
        data: {
          rank: -1 * (index + 1),
        },
      });
    }

    for (const row of input.rows) {
      await tx.seasonRanking.upsert({
        where: participantRankingWhere(input, row.seasonParticipantId),
        create: {
          seasonId: input.seasonId,
          seasonParticipantId: row.seasonParticipantId,
          rankType: input.rankType,
          rank: row.rank,
          totalAssetKrw: row.totalAssetKrw,
          returnRate: row.returnRate,
          rankingDate: input.rankingDate,
          capturedAt: input.capturedAt,
        },
        update: {
          rank: row.rank,
          totalAssetKrw: row.totalAssetKrw,
          returnRate: row.returnRate,
          capturedAt: input.capturedAt,
        },
      });
    }

    await tx.seasonRanking.deleteMany({
      where: {
        seasonId: input.seasonId,
        rankType: input.rankType,
        rankingDate: input.rankingDate,
        seasonParticipantId: {
          notIn: input.rows.map((row) => row.seasonParticipantId),
        },
        rank: {
          lt: 0,
        },
      },
    });
  });

  return input.rows.map((row) => ({
    ...row,
    dryRun: false,
  }));
}

function participantRankingWhere(
  input: Pick<SeasonRankingWriteInput, 'seasonId' | 'rankType' | 'rankingDate'>,
  seasonParticipantId: string,
) {
  return {
    seasonId_rankType_rankingDate_seasonParticipantId: {
      seasonId: input.seasonId,
      rankType: input.rankType,
      rankingDate: input.rankingDate,
      seasonParticipantId,
    },
  };
}
