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
  return { meQuery, rankingQuery, rankType, hasSeason: account?.mode === 'season',
    refreshQueries: [meQuery, { ...rankingQuery, enabled: !!season?.seasonId }] };
}

export type HomeAccountContextData = ReturnType<typeof useHomeAccountContext>;

export default function HomeAccountContext({ context }: { context: HomeAccountContextData }) {
  const { meQuery, rankingQuery, rankType, hasSeason } = context;
  const { fontScale } = useWindowDimensions();
  const myRanking = rankingQuery.data?.myRanking.state === 'available' ? rankingQuery.data.myRanking : null;
  return (
    <AccountSwitcher home>
      <View style={styles.details}>
        <View style={[styles.identity, { flexBasis: 140 * fontScale }]}>
          {meQuery.isLoading ? <SectionSkeleton lines={1} /> : meQuery.data ? <>
            <ProfileAvatar profileImageUrl={meQuery.data.profileImageUrl} size={36} testID="home-profile-avatar" />
            <Text testID={TEST_IDS.home.nickname} style={styles.nickname}>{meQuery.data.nickname}</Text>
          </> : <InlineEmptyState message="사용자 정보를 불러오지 못했습니다." />}
        </View>
        {hasSeason ? <View style={[styles.ranking, { flexBasis: 160 * fontScale }]}>
          <View style={styles.metric}>
            <Text style={styles.label}>{rankType === 'final' ? '최종 순위' : '현재 순위'}</Text>
            {rankingQuery.isLoading ? <SectionSkeleton lines={1} /> :
              <Text testID={TEST_IDS.home.rank} style={styles.value}>{myRanking ? `#${myRanking.rank}` : '-'}</Text>}
          </View>
          <View style={styles.metric}>
            <Text style={styles.label}>{rankType === 'final' ? '최종 등급' : '현재 등급'}</Text>
            {rankingQuery.isLoading ? <SectionSkeleton lines={1} /> :
              <Text testID={TEST_IDS.home.tier} style={styles.value}>{getRankingTier(myRanking, rankType)}</Text>}
          </View>
        </View> : null}
      </View>
      {hasSeason && rankingQuery.isError ? <Text style={styles.notice}>랭킹 정보를 불러오지 못했습니다.</Text> : null}
    </AccountSwitcher>
  );
}

const styles = StyleSheet.create({
  details: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10, flexGrow: 1, flexShrink: 1, minWidth: 0 },
  nickname: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', lineHeight: 23 },
  ranking: { flexDirection: 'row', flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 12 },
  metric: { flex: 1, minWidth: 0, gap: 2 },
  label: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  value: { fontSize: 18, lineHeight: 27, fontWeight: '700' },
  notice: { fontSize: 13, lineHeight: 20, color: semantic.warning },
});
