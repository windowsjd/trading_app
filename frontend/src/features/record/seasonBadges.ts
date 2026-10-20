import type { RecordSeasonListItemDto } from './api';

export type SeasonBadge = {
  seasonId: string;
  seasonName: string;
  displayBadge?: 'beta';
  finalRank: number;
  /** The ranking API's tier code (`gold`, `master`, …). */
  finalTier: string;
  returnRate: string | null;
  totalAssetKrw: string | null;
};

/**
 * 내 뱃지: one card per season whose settlement confirmed my final rank and
 * tier. Nothing is stored for it: every card is read from settlement's
 * official result through `/records/me/seasons` (no new table, no copy that
 * could drift).
 *
 *  - `seasonStatus === 'settled'`: settlement committed. One transaction
 *    writes the final ranking rows, the participant's finalRank/finalTier and
 *    Season.status, so an ended season's provisional figures never become a
 *    badge, and a retried settlement cannot add a second result.
 *  - finalRank/finalTier: the participant's columns, which an operator
 *    correction updates together with the final ranking row's rank; the next
 *    read shows the corrected result.
 *  - returnRate/totalAssetKrw: the participant's final ranking row whenever it
 *    exists (records `selectBestMetric`), and settlement writes it for every
 *    participant it ranks.
 *
 * A participant without a confirmed final rank (not qualified, excluded or
 * unranked) gets no card, never an invented rank or tier. One card per season.
 */
export function toSeasonBadges(items: readonly RecordSeasonListItemDto[]): SeasonBadge[] {
  const bySeason = new Map<string, SeasonBadge>();
  for (const item of items) {
    const finalTier = item.finalTier?.trim();
    const finalRank = item.finalRank;
    if (item.seasonStatus !== 'settled' || item.participantStatus === 'excluded' || item.finalQualified === false) continue;
    if (!finalTier || typeof finalRank !== 'number' || !Number.isInteger(finalRank) || finalRank < 1) continue;
    if (bySeason.has(item.seasonId)) continue;
    bySeason.set(item.seasonId, {
      seasonId: item.seasonId,
      seasonName: item.seasonName,
      ...(item.displayBadge === 'beta' ? { displayBadge: 'beta' as const } : {}),
      finalRank,
      finalTier,
      returnRate: item.latestReturnRate ?? null,
      totalAssetKrw: item.latestTotalAssetKrw ?? null,
    });
  }
  return [...bySeason.values()];
}
