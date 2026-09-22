import { Prisma, SeasonRankingType } from '../generated/prisma/client';

/** Call only while holding the Season write lock. Equal timestamps identify
 * the same public snapshot: first publication wins, including across instances.
 * Runtime refresh compares all dates because it also writes participant current
 * values; a historical daily writer may compare only the date it replaces. */
export async function isCurrentRankingSuperseded(
  tx: Pick<Prisma.TransactionClient, 'seasonRanking'>,
  input: { seasonId: string; capturedAt: Date; rankingDate?: Date },
): Promise<boolean> {
  const latest = await tx.seasonRanking.findFirst({
    where: {
      seasonId: input.seasonId,
      rankType: SeasonRankingType.daily,
      ...(input.rankingDate ? { rankingDate: input.rankingDate } : {}),
    },
    orderBy: { capturedAt: 'desc' },
    select: { capturedAt: true },
  });
  return !!latest && latest.capturedAt.getTime() >= input.capturedAt.getTime();
}
