import { Prisma, SeasonRankingType } from '../generated/prisma/client';
import {
  assertSeasonRankingScopes,
  SEASON_RANKING_SCOPE_SELECT,
} from './season-ranking-scope';

/**
 * WHOLE-SET scope preflight for SeasonRanking readers (작업 8 보완 §A-4).
 *
 * `assertSeasonRankingScopes` verifies the rows a reader actually loaded. That
 * is exactly the wrong granularity for a leaderboard, because a leaderboard is
 * PAGINATED and a ranking is a ranking only as a whole:
 *
 *   - `GET /ranking?offset=0&limit=50` over a 100-row season verified 50 rows.
 *     A null scope on rank 87 was invisible, so page 1 returned 200 OK with a
 *     leaderboard whose composition nobody had checked.
 *   - `scope=top10` verified 10 rows and reported `percentile` computed from a
 *     `total` counted over the damaged set.
 *   - `HomeService` / `RecordsService` verified ONE participant's row and then
 *     counted the whole set for `totalParticipants`, so a user's percentile and
 *     tier were derived from rows that were never checked.
 *
 * A ranking set is identified by `(seasonId, rankType, rankingDate,
 * capturedAt)` — the same snapshot key the pagination contract pins — and this
 * preflight verifies EVERY row under that key before any page is served.
 *
 * WHAT IS DELIBERATELY NOT DONE
 * -----------------------------
 * Damaged rows are not filtered out, `total` is not recounted over the healthy
 * remainder, and ranks are not reassigned. Each of those turns a detectable
 * fault into an undetectable one: omitting a competitor promotes everyone below
 * them, and the resulting leaderboard is self-consistent and wrong. The whole
 * set fails closed with the existing structured 500 instead.
 *
 * Only the SCOPE columns are loaded — never the public payload — so the cost is
 * one narrow indexed read per ranking request, bounded by the number of season
 * participants.
 *
 * Absence is still absence: a key with no rows at all verifies successfully and
 * the caller keeps its existing `unavailable` contract.
 */

type SeasonRankingSetClient = {
  seasonRanking: {
    findMany: (args: {
      where: Prisma.SeasonRankingWhereInput;
      select: typeof SEASON_RANKING_SET_SCOPE_SELECT;
    }) => Promise<unknown[]>;
  };
};

const SEASON_RANKING_SET_SCOPE_SELECT = {
  ...SEASON_RANKING_SCOPE_SELECT,
  id: true,
} satisfies Prisma.SeasonRankingSelect;

export type SeasonRankingSetKey = {
  seasonId: string;
  rankType: SeasonRankingType;
  rankingDate: Date;
  /**
   * Omit to verify every capture of `rankingDate` rather than one snapshot.
   * Readers that pin a snapshot (the ranking API) pass it; readers that only
   * aggregate a date (home/records `totalParticipants`) do not.
   */
  capturedAt?: Date;
};

/**
 * Verifies every row of one ranking set. Returns how many rows were checked so
 * callers can log or reuse the count; throws the structured
 * `SEASON_RANKING_SCOPE_*` / `TRADING_ACCOUNT_LINK_INTEGRITY` 500 on damage.
 */
export async function assertSeasonRankingSetScope(
  client: SeasonRankingSetClient,
  key: SeasonRankingSetKey,
): Promise<number> {
  const rows = await client.seasonRanking.findMany({
    where: {
      seasonId: key.seasonId,
      rankType: key.rankType,
      rankingDate: key.rankingDate,
      ...(key.capturedAt ? { capturedAt: key.capturedAt } : {}),
    },
    select: SEASON_RANKING_SET_SCOPE_SELECT,
  });

  // The set is verified in full — including rows a public WHERE would hide.
  // A hidden or excluded participant's damaged row is still damage, and the
  // ranks around it are still the ranks this response publishes.
  assertSeasonRankingScopes(
    rows as Parameters<typeof assertSeasonRankingScopes>[0],
  );

  return rows.length;
}
