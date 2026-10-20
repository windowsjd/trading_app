import SeasonTitle from '../../components/tradingAccount/SeasonTitle';
import React from 'react';
import { StyleSheet } from '../../theme/native';
import { TEST_IDS } from '../../constants/testIds';
import type { SeasonBadge } from '../../features/record/seasonBadges';
import StandingCard from '../ranking/StandingCard';

/**
 * One season's badge — its name, final tier and emblem, final rank, final
 * return rate and final assets on the Ranking tab's 내 순위 card
 * (StandingCard). The same card on MY → 내 뱃지 and on 시즌최종결과.
 */
export default function SeasonBadgeCard({ badge }: { badge: SeasonBadge }) {
  const prefix = TEST_IDS.badges.card(badge.seasonId);
  return (
    <StandingCard
      testIDPrefix={prefix}
      tier={badge.finalTier}
      rankLabel="최종 순위"
      rank={badge.finalRank}
      figures={{ returnRate: badge.returnRate, totalAssetKrw: badge.totalAssetKrw }}
      figureLabels={{ rate: '최종 수익률', total: '최종 자산' }}
      header={(foreground) => (
        <SeasonTitle testID={`${prefix}-season`} style={[styles.seasonName, foreground]} name={badge.seasonName} displayBadge={badge.displayBadge} />
      )}
    />
  );
}

const styles = StyleSheet.create({
  // The same size and weight as the profile name on the Ranking tab's card.
  seasonName: { minWidth: 0, fontSize: 18, lineHeight: 26, fontWeight: '700' },
});
