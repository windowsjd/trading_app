// Runtime imports carry the .ts extension so `node --test` can load this module.
import type { MyRankingDto, RankingItemDto, RankingsResponseDto } from './api';

export type PodiumPlace = 1 | 2 | 3;
export type PodiumEntry = { place: PodiumPlace; item: RankingItemDto; mine: boolean };

/**
 * TOP 3 시상대: the whole (전체) ranking's first three rows of the ranking
 * tab's publication (scope all, offset 0) — whatever tab is selected. Shown
 * only when ranks 1, 2 and 3 are all confirmed as the first three rows of
 * that set; anything else (fewer rows, a gap, another window) draws nothing,
 * never a guessed podium. `mine` compares participant ids, never nicknames.
 */
export function podiumEntries(
  publication: RankingsResponseDto | undefined,
  myRanking: MyRankingDto | null | undefined,
): PodiumEntry[] | null {
  if (!publication || publication.state !== 'available' || publication.pagination?.offset !== 0) return null;
  const [first, second, third] = publication.rankings;
  if (!first || !second || !third || first.rank !== 1 || second.rank !== 2 || third.rank !== 3) return null;
  const ids = new Set([first.seasonParticipantId, second.seasonParticipantId, third.seasonParticipantId]);
  if (ids.size !== 3) return null;
  const mineId = myRanking?.state === 'available' ? myRanking.seasonParticipantId : null;
  return ([first, second, third] as const).map((item, index) => ({
    place: (index + 1) as PodiumPlace,
    item,
    mine: mineId !== null && item.seasonParticipantId === mineId,
  }));
}
