import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { View, Text, StyleSheet, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import type { TradingAccountDto } from '../../features/tradingAccount/api';
import { getMe } from '../../features/me/api';
import { getRankings, getRankingTier } from '../../features/ranking/api';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';
import ProfileAvatar from '../../components/common/ProfileAvatar';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import { useAppearance } from '../../theme/appearance';
import { getHomeTier } from './tierPresentation';
import TierEmblem from './TierEmblem';

export function useHomeAccountContext(account: TradingAccountDto | null) {
  const season = account?.mode === 'season' ? account.season : null;
  const rankType: 'final' | 'daily' = season?.seasonStatus === 'settled' ? 'final' : 'daily';
  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000, enabled: !!account,
  });
  const rankingQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.list({
      scope: 'all', seasonId: season?.seasonId ?? null, rankType, limit: 1, offset: 0,
    }),
    queryFn: () => getRankings({ scope: 'all', seasonId: season?.seasonId, rankType, limit: 1, offset: 0 }),
    enabled: !!season?.seasonId,
  });
  return { meQuery, rankingQuery, rankType, hasSeason: account?.mode === 'season', seasonId: season?.seasonId ?? null,
    refreshQueries: [meQuery, { ...rankingQuery, enabled: !!season?.seasonId }] };
}

export type HomeAccountContextData = ReturnType<typeof useHomeAccountContext>;

export default function HomeAccountContext({ context }: { context: HomeAccountContextData }) {
  const { meQuery, rankingQuery, rankType, hasSeason, seasonId } = context;
  const { width } = useWindowDimensions();
  const { mode } = useAppearance();
  const loading = !!seasonId && rankingQuery.isLoading;
  const myRanking = !rankingQuery.isError && !loading && seasonId &&
    rankingQuery.data?.state === 'available' && rankingQuery.data.myRanking.state === 'available'
    ? rankingQuery.data.myRanking : null;
  const tier = hasSeason ? getHomeTier(getRankingTier(myRanking, rankType), mode) : null;
  const emblemSize = width < 360 ? 132 : 160;
  const rank = myRanking && Number.isFinite(myRanking.rank) && myRanking.rank > 0 ? `#${myRanking.rank}` : '-';
  const tierLabel = tier?.name ?? (loading ? '티어 확인 중' : rankingQuery.isError ? '티어 확인 실패' : '티어 미정');
  const notice = rankingQuery.isError ? '랭킹 정보를 불러오지 못했습니다.' :
    !loading && !!seasonId && !myRanking ? '아직 표시할 랭킹 정보가 없습니다.' : null;
  return (
    <AccountSwitcher home homeCardStyle={tier ? { backgroundColor: tier.palette.backgroundColor, borderColor: tier.palette.borderColor } : undefined}
      homeVisual={hasSeason ? <View style={styles.tier}>
        {tier ? <TierEmblem tier={tier.id} size={emblemSize} /> :
          <View testID="home-tier-neutral" style={[styles.neutral, { width: emblemSize, height: emblemSize }]}
            accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
            <View style={styles.neutralRing}><Text style={styles.neutralMark}>—</Text></View>
          </View>}
        <Text testID={TEST_IDS.home.tier} style={[styles.tierName, tier && { color: tier.palette.color }]}
          accessibilityLiveRegion="polite">{tierLabel}</Text>
      </View> : undefined}>
      <View style={styles.userDetails}>
        <View style={styles.identity}>
          {meQuery.isLoading ? <SectionSkeleton lines={1} /> : meQuery.data ? <>
            <ProfileAvatar profileImageUrl={meQuery.data.profileImageUrl} size={36} testID="home-profile-avatar" />
            <Text testID={TEST_IDS.home.nickname} style={[styles.nickname, hasSeason && styles.seasonNickname]}>{meQuery.data.nickname}</Text>
          </> : <InlineEmptyState message="사용자 정보를 불러오지 못했습니다." />}
        </View>
        {hasSeason ? <Text testID={TEST_IDS.home.rank} style={[styles.rank, tier && { color: tier.palette.color }]}
          accessibilityLabel={`${rankType === 'final' ? '최종' : '현재'} 순위 ${rank === '-' ? '확인 중 또는 정보 없음' : rank}`}>
          {loading ? '—' : rank}
        </Text> : null}
      </View>
      {hasSeason && notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </AccountSwitcher>
  );
}

const styles = StyleSheet.create({
  userDetails: { minWidth: 0, gap: 10 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  nickname: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', lineHeight: 23 },
  seasonNickname: { fontSize: 18, lineHeight: 27, fontWeight: '700' },
  rank: { fontSize: 20, lineHeight: 30, fontWeight: '600', color: semantic.secondary, flexShrink: 1 },
  tier: { alignItems: 'center', gap: 2, flexShrink: 0, maxWidth: '100%' },
  tierName: { fontSize: 20, lineHeight: 29, fontWeight: '700', textAlign: 'center', color: semantic.secondary },
  neutral: { alignItems: 'center', justifyContent: 'center' },
  neutralRing: { width: '65%', height: '65%', borderRadius: 999, borderWidth: 1, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' },
  neutralMark: { fontSize: 28, color: semantic.muted },
  notice: { fontSize: 13, lineHeight: 20, color: semantic.warning },
});
