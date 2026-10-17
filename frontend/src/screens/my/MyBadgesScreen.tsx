import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { semantic } from '../../theme/tokens';
import React, { useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, SafeAreaView, FlatList, Platform } from '../../theme/native';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { useInfiniteQuery } from '@tanstack/react-query';

import type { MyBadgesScreenProps } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { getMySeasonRecords } from '../../features/record/api';
import { toSeasonBadges, type SeasonBadge } from '../../features/record/seasonBadges';

import ActionPressable from '../../components/common/ActionPressable';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';
import WhaleLoader from '../../components/states/WhaleLoader';
import StandingCard from '../ranking/StandingCard';

/** The records contract's largest page: one page holds any realistic season history. */
const PAGE_LIMIT = 100;

/**
 * 내 뱃지: one card per settled season with my official final result — the
 * season's name, final tier and emblem, final rank and final return rate —
 * on the Ranking tab's own 내 순위 card (StandingCard). Cards are read from
 * settlement's result (toSeasonBadges); this screen stores nothing, so a new
 * season never replaces an old card and a correction shows on the next read.
 *
 * Badges are a record of results, not a payout: the reward ledger keeps its
 * own screen (Reward), linked at the bottom.
 */
export default function MyBadgesScreen({ navigation }: MyBadgesScreenProps) {
  const recordsQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.record.seasonBadges(PAGE_LIMIT),
    queryFn: ({ pageParam }) =>
      getMySeasonRecords({ seasonStatus: 'settled', limit: PAGE_LIMIT, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
  });
  const refresh = usePullToRefresh([recordsQuery]);
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = recordsQuery;

  // Every page is read: a card hidden on a later page would look like a lost season.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const badges = useMemo(
    () => toSeasonBadges(recordsQuery.data?.pages.flatMap((page) => page.items) ?? []),
    [recordsQuery.data],
  );

  if (recordsQuery.isLoading) {
    return <FullPageLoading message="뱃지를 불러오는 중입니다." />;
  }

  if (recordsQuery.isError && !recordsQuery.data) {
    return (
      <ErrorState
        error={recordsQuery.error}
        title="뱃지를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void recordsQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.badges.screen}
        data={badges}
        keyExtractor={(badge) => badge.seasonId}
        refreshControl={refresh.refreshControl}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <Text style={styles.intro}>시즌 정산으로 확정된 최종 티어와 성적을 시즌마다 보관합니다.</Text>
        }
        ListEmptyComponent={
          <EmptyState
            title="아직 보관된 시즌 뱃지가 없습니다."
            message="시즌이 정산되면 그 시즌의 최종 티어와 성적이 이곳에 보관됩니다."
          />
        }
        renderItem={({ item }) => <SeasonBadgeCard badge={item} />}
        ListFooterComponent={
          <View style={styles.footer}>
            {isFetchingNextPage ? <WhaleLoader size={28} /> : null}
            <ActionPressable
              testID={TEST_IDS.badges.rewardHistory}
              accessibilityRole="button"
              style={styles.rewardRow}
              onPress={() => navigation.navigate('Reward')}
            >
              <Text style={styles.rewardTitle}>보상 지급 내역</Text>
              <Text style={styles.rewardHelper}>뱃지는 성적 기록이며, 보상 지급과는 별도로 관리됩니다.</Text>
            </ActionPressable>
          </View>
        }
      />
    </SafeAreaView>
  );
}

function SeasonBadgeCard({ badge }: { badge: SeasonBadge }) {
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
        <Text testID={`${prefix}-season`} style={[styles.seasonName, foreground]}>{badge.seasonName}</Text>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, paddingBottom: 24 },
  intro: { fontSize: 14, lineHeight: 21, color: semantic.secondary, marginBottom: 12 },
  // The same size and weight as the profile name on the Ranking tab's card.
  seasonName: { minWidth: 0, fontSize: 18, lineHeight: 26, fontWeight: '700' },
  footer: { gap: 12 },
  rewardRow: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: semantic.surface,
    gap: 4,
  },
  rewardTitle: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  rewardHelper: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
});
