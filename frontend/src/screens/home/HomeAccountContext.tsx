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
import ErrorNotice from '../../components/states/ErrorNotice';
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

/** The season ranking row behind Home's rank and tier (never for general/beginner). */
function readSeasonStanding(context: HomeAccountContextData, mode: 'light' | 'dark') {
  const { rankingQuery, rankType, hasSeason, seasonId } = context;
  const loading = !!seasonId && rankingQuery.isLoading;
  const myRanking = !rankingQuery.isError && !loading && seasonId &&
    rankingQuery.data?.state === 'available' && rankingQuery.data.myRanking.state === 'available'
    ? rankingQuery.data.myRanking : null;
  const tier = hasSeason ? getHomeTier(getRankingTier(myRanking, rankType), mode) : null;
  const rank = myRanking && Number.isFinite(myRanking.rank) && myRanking.rank > 0 ? `#${myRanking.rank}` : '-';
  const tierLabel = tier?.name ?? (loading ? '티어 확인 중' : rankingQuery.isError ? '티어 확인 실패' : '티어 미정');
  const notice = rankingQuery.isError ? '랭킹 정보를 불러오지 못했습니다.' :
    !loading && !!seasonId && !myRanking ? '아직 표시할 랭킹 정보가 없습니다.' : null;
  return { loading, tier, rank, tierLabel, notice };
}

/**
 * One account box for general, beginner and season accounts: the mode or
 * season title and the change action on top, the profile right below. The
 * season tier is shown next to the total assets (HomeTierBadge).
 */
export default function HomeAccountContext({ context }: { context: HomeAccountContextData }) {
  const { meQuery, rankingQuery, rankType, hasSeason } = context;
  const { mode } = useAppearance();
  const { loading, rank, notice } = readSeasonStanding(context, mode);
  return (
    <AccountSwitcher home>
      <View style={styles.identity}>
        {meQuery.isLoading ? <View style={styles.flex}><SectionSkeleton lines={1} /></View> : meQuery.data ? <>
          <ProfileAvatar profileImageUrl={meQuery.data.profileImageUrl} size={32} testID="home-profile-avatar" />
          <Text testID={TEST_IDS.home.nickname} style={styles.nickname}>{meQuery.data.nickname}</Text>
        </> : <View style={styles.flex}><InlineEmptyState message="사용자 정보를 불러오지 못했습니다." /></View>}
        {hasSeason ? <Text testID={TEST_IDS.home.rank} style={styles.rank}
          accessibilityLabel={`${rankType === 'final' ? '최종' : '현재'} 순위 ${rank === '-' ? '확인 중 또는 정보 없음' : rank}`}>
          {loading ? '—' : rank}
        </Text> : null}
      </View>
      {hasSeason && notice ? rankingQuery.isError
        ? <ErrorNotice error={rankingQuery.error} message={notice} style={styles.notice} />
        : <Text style={styles.notice}>{notice}</Text> : null}
    </AccountSwitcher>
  );
}

/**
 * The season tier emblem beside the total assets. The emblem keeps its
 * original proportions; the numbers stay the larger, primary information.
 */
export function HomeTierBadge({ context }: { context: HomeAccountContextData }) {
  const { mode } = useAppearance();
  const { width, fontScale } = useWindowDimensions();
  const { tier, tierLabel } = readSeasonStanding(context, mode);
  if (!context.hasSeason) return null;
  const size = width < 360 || fontScale > 1.3 ? 68 : 84;
  return (
    <View testID="home-tier-badge" style={styles.tier}>
      {tier ? <TierEmblem tier={tier.id} size={size} /> :
        <View testID="home-tier-neutral" style={[styles.neutral, { width: size, height: size }]}
          accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
          <View style={styles.neutralRing}><Text style={styles.neutralMark}>—</Text></View>
        </View>}
      <Text testID={TEST_IDS.home.tier} style={styles.tierName} accessibilityLabel={`시즌 티어 ${tierLabel}`}
        accessibilityLiveRegion="polite">{tierLabel}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  // The rank sits beside the name and wraps below it when large text needs the room.
  identity: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4, minWidth: 0 },
  nickname: { flexGrow: 1, flexShrink: 1, flexBasis: 120, minWidth: 0, fontSize: 16, fontWeight: '600', lineHeight: 24 },
  rank: { marginLeft: 'auto', maxWidth: '100%', fontSize: 18, lineHeight: 26, fontWeight: '700', color: semantic.secondary, fontVariant: ['tabular-nums'] },
  tier: { alignItems: 'center', gap: 2, flexShrink: 0, maxWidth: 120 },
  tierName: { fontSize: 13, lineHeight: 19, fontWeight: '700', textAlign: 'center', color: semantic.secondary },
  neutral: { alignItems: 'center', justifyContent: 'center' },
  neutralRing: { width: '65%', height: '65%', borderRadius: 999, borderWidth: 1, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' },
  neutralMark: { fontSize: 22, color: semantic.muted },
  notice: { fontSize: 13, lineHeight: 20, color: semantic.warning },
});
