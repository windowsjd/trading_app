import { Prisma, SeasonRankingType } from '../generated/prisma/client';
import { RankingCalculatedRow } from '../ranking/ranking-calculation.policy';
import {
  assertExistingRankingRowScopeWritable,
  resolveSeasonRankingAccountScopes,
} from '../ranking/season-ranking-scope';

export type SeasonRankingWriteInput = {
  seasonId: string;
  rankType: SeasonRankingType;
  rankingDate: Date;
  capturedAt: Date;
  rows: readonly RankingCalculatedRow[];
  dryRun: boolean;
};

export type SeasonRankingWriteResult = RankingCalculatedRow & {
  dryRun: boolean;
  tradingAccountId: string | null;
};

type SeasonRankingWriter = {
  $transaction: <T>(
    callback: (tx: SeasonRankingTransaction) => Promise<T>,
  ) => Promise<T>;
};

type SeasonRankingTransaction = Pick<
  Prisma.TransactionClient,
  'seasonParticipant'
> & {
  seasonRanking: {
    findMany: (args: unknown) => Promise<
      Array<{
        id: string;
        seasonParticipantId: string;
        tradingAccountId: string | null;
      }>
    >;
    update: (args: unknown) => Promise<unknown>;
    upsert: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
};

/**
 * Admin/script ranking writer. Dual-writes `tradingAccountId` alongside
 * `seasonParticipantId` on every row it creates (작업 8 §8).
 *
 * The scope is resolved for ALL participants up front, before a single row is
 * touched: a participant with a broken account link aborts the whole write
 * rather than producing a ranking that is missing one competitor. Existing rows
 * are additionally checked with `assertExistingRankingRowScopeWritable`, so a
 * legacy null scope is surfaced for the repair script instead of being quietly
 * filled in by a routine regeneration.
 */
export async function writeSeasonRankings(
  prisma: SeasonRankingWriter,
  input: SeasonRankingWriteInput,
): Promise<SeasonRankingWriteResult[]> {
  if (input.dryRun) {
    return input.rows.map((row) => ({
      ...row,
      dryRun: true,
      // A dry run resolves no scope because it opens no transaction; the value
      // is reported as unknown rather than guessed.
      tradingAccountId: null,
    }));
  }

  const scopedAccountIds = new Map<string, string>();

  await prisma.$transaction(async (tx) => {
    const scopes = await resolveSeasonRankingAccountScopes(tx, {
      seasonId: input.seasonId,
      seasonParticipantIds: input.rows.map((row) => row.seasonParticipantId),
    });
    for (const [participantId, scope] of scopes) {
      scopedAccountIds.set(participantId, scope.tradingAccountId);
    }

    const existingRows = await tx.seasonRanking.findMany({
      where: {
        seasonId: input.seasonId,
        rankType: input.rankType,
        rankingDate: input.rankingDate,
      },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
      },
    });

    // Rows that survive this regeneration must already be correctly scoped.
    // Ones that disappear (negative rank, then deleted below) are not checked:
    // they are on their way out and blocking on their scope would make a stale
    // damaged row permanently un-removable.
    for (const row of existingRows) {
      const expectedAccountId = scopes.get(
        row.seasonParticipantId,
      )?.tradingAccountId;
      if (expectedAccountId) {
        assertExistingRankingRowScopeWritable({
          rankingId: row.id,
          storedTradingAccountId: row.tradingAccountId,
          expectedTradingAccountId: expectedAccountId,
        });
      }
    }

    for (const [index, row] of existingRows.entries()) {
      await tx.seasonRanking.update({
        where: participantRankingWhere(input, row.seasonParticipantId),
        data: {
          rank: -1 * (index + 1),
        },
      });
    }

    for (const row of input.rows) {
      const tradingAccountId = scopedAccountIds.get(row.seasonParticipantId)!;

      await tx.seasonRanking.upsert({
        where: participantRankingWhere(input, row.seasonParticipantId),
        create: {
          seasonId: input.seasonId,
          seasonParticipantId: row.seasonParticipantId,
          tradingAccountId,
          rankType: input.rankType,
          rank: row.rank,
          totalAssetKrw: row.totalAssetKrw,
          returnRate: row.returnRate,
          maxDrawdown: row.maxDrawdown,
          totalFillCount: row.totalFillCount,
          reachedReturnAt: row.reachedReturnAt,
          rankingDate: input.rankingDate,
          capturedAt: input.capturedAt,
        },
        update: {
          // Re-stated on update as well: the scope of an existing row has
          // already been proven to equal this value, so writing it is a no-op
          // that also repairs nothing it should not.
          tradingAccountId,
          rank: row.rank,
          totalAssetKrw: row.totalAssetKrw,
          returnRate: row.returnRate,
          maxDrawdown: row.maxDrawdown,
          totalFillCount: row.totalFillCount,
          reachedReturnAt: row.reachedReturnAt,
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
    tradingAccountId: scopedAccountIds.get(row.seasonParticipantId) ?? null,
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
