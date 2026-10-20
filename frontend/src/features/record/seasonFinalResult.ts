// Runtime imports carry the .ts extension so `node --test` can load this module.
import type { SeasonFinalResultDto, SeasonFinalResultStateDto } from './api';
import { toSeasonBadges, type SeasonBadge } from './seasonBadges.ts';

/** What a settled result without a final rank or tier says in their place. */
export const FINAL_RANKING_NOT_QUALIFIED_LABEL = '최종 랭킹 자격 미충족';

/**
 * Results the 시즌최종결과 screen shows as the season's official outcome — and
 * therefore the only ones it records as seen. A pending, unverifiable or
 * not-joined result is never marked: the season entry keeps offering
 * 시즌결과 확인하기 until a real result has been on screen.
 */
export function isShownFinalResult(result: SeasonFinalResultStateDto): boolean {
  return (
    result.state === 'available' ||
    result.state === 'not_qualified' ||
    result.state === 'excluded'
  );
}

/**
 * The season's badge by 내 뱃지's own rule (toSeasonBadges) over the same
 * settled figures, so the result screen and MY → 내 뱃지 show the same card,
 * or none. A participant without a confirmed final rank and tier has none.
 */
export function finalResultBadge(dto: SeasonFinalResultDto): SeasonBadge | null {
  const { result } = dto;
  if (result.state !== 'available') return null;
  return (
    toSeasonBadges([
      {
        seasonId: dto.season.id,
        seasonName: dto.season.name,
        seasonStatus: dto.season.status,
        participantStatus: dto.participantStatus ?? undefined,
        joinedAt: '',
        finalRank: result.finalRank,
        finalTier: result.finalTier,
        latestReturnRate: result.returnRate,
        latestTotalAssetKrw: result.totalAssetKrw,
      },
    ])[0] ?? null
  );
}
