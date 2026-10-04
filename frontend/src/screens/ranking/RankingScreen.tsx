import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { semantic } from '../../theme/tokens';
import { getScreenContentStyle } from '../../theme/screenLayout';
import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RankingScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getCurrentSeason } from '../../features/season/api';
import {
  getRankingTier,
  getRankings,
  type MyRankingDto,
  type RankingItemDto,
  type RankingRankType,
  type RankingScope,
} from '../../features/ranking/api';
import { ERROR_CODE } from '../../models/enums/errorCode';
import { getApiErrorCode } from '../../services/api/errorMapper';
import {
  formatKrw,
  formatPercent,
} from '../../utils/format';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';
import CTAButton from '../../components/common/CTAButton';
import ProfileAvatar from '../../components/common/ProfileAvatar';
import { getMe, type MeDto } from '../../features/me/api';

type Props = RankingScreenProps;

const TABS: Array<{ key: RankingScope; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'friends', label: '친구' },
  { key: 'top10', label: 'TOP10' },
];

function getRankingItemKey(item: RankingItemDto) {
  return item.seasonParticipantId;
}

export default function RankingScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000 });
  const [selectedTab, setSelectedTab] = React.useState<RankingScope>('all');
  const snapshotResetAttemptRef = React.useRef(0);
  const rankingLimit = selectedTab === 'top10' ? 10 : 50;
  const { width, fontScale } = useWindowDimensions();
  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });
  // The API defaults to daily, including settled seasons. Select final explicitly
  // after settlement, then pin every scope to this canonical publication.
  const publicationRankType: RankingRankType = seasonQuery.data?.status === 'settled' ? 'final' : 'daily';
  const publicationParams = { scope: 'all' as const, seasonId: seasonQuery.data?.id, rankType: publicationRankType, limit: 3, offset: 0 };
  const topQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.list(publicationParams),
    queryFn: () => getRankings(publicationParams),
    enabled: !!seasonQuery.data,
    refetchInterval: (query) =>
      query.state.data?.rankType === 'final' || seasonQuery.data?.status === 'settled'
        ? false : 60_000,
  });
  const publication = topQuery.data;
  const rankType = publication?.rankType;
  const seasonId = publication?.season?.id;
  const rankingDate = publication?.rankingDate;
  const capturedAt = publication?.capturedAt;
  const rankingQueryKey = useMemo(
    () => QUERY_KEYS.ranking.infiniteList({
      scope: selectedTab, limit: rankingLimit, offset: 0,
      seasonId, rankType, rankingDate, capturedAt,
    }),
    [selectedTab, rankingLimit, seasonId, rankType, rankingDate, capturedAt],
  );

  const rankingQuery = useInfiniteQuery({
    queryKey: rankingQueryKey,
    enabled: publication?.state === 'available',
    queryFn: ({ pageParam }) =>
      getRankings({
        scope: selectedTab,
        seasonId,
        limit: rankingLimit,
        offset: pageParam.offset,
        rankType: pageParam.rankType,
        rankingDate: pageParam.rankingDate,
        capturedAt: pageParam.capturedAt,
      }),
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.pagination.nextOffset;
      if (nextOffset === null || nextOffset === undefined) return undefined;

      return {
        offset: nextOffset,
        rankType: lastPage.rankType,
        rankingDate: lastPage.rankingDate ?? null,
        capturedAt: lastPage.capturedAt ?? null,
      };
    },
    initialPageParam: {
      offset: 0,
      rankType,
      rankingDate: rankingDate ?? null,
      capturedAt: capturedAt ?? null,
    },
  });
  const refresh = usePullToRefresh([seasonQuery, meQuery, {
    isFetching: topQuery.isFetching || rankingQuery.isFetching,
    refetch: async () => {
      const latest = await topQuery.refetch();
      if (latest.data?.season?.id === seasonId && latest.data?.rankType === rankType &&
          latest.data?.rankingDate === rankingDate && latest.data?.capturedAt === capturedAt) {
        await rankingQuery.refetch();
      }
      // A new publication changes the list key and loads its first page.
    },
  }]);

  const items = useMemo(() => {
    const byKey = new Map<string, RankingItemDto>();

    rankingQuery.data?.pages.forEach((page) => {
      page.rankings.forEach((item) => {
        byKey.set(getRankingItemKey(item), item);
      });
    });

    return Array.from(byKey.values());
  }, [rankingQuery.data]);

  const myRanking = publication?.myRanking ?? null;
  const hasNotJoined = myRanking?.state === 'not_joined' || seasonQuery.data?.joined === false;
  const rankingErrorCode = getApiErrorCode(rankingQuery.error);

  React.useEffect(() => {
    snapshotResetAttemptRef.current = 0;
  }, [selectedTab]);

  React.useEffect(() => {
    if (rankingQuery.isSuccess) {
      snapshotResetAttemptRef.current = 0;
    }
  }, [
    rankingQuery.isSuccess,
    rankingQueryKey,
  ]);

  const refetchRankings = topQuery.refetch;
  React.useEffect(() => {
    if (rankingErrorCode !== ERROR_CODE.RANKING_SNAPSHOT_CHANGED) return;
    if (snapshotResetAttemptRef.current > 0) return;

    snapshotResetAttemptRef.current += 1;
    void refetchRankings().then(() =>
      queryClient.resetQueries({ queryKey: rankingQueryKey, exact: true }),
    );
  }, [queryClient, rankingErrorCode, refetchRankings, rankingQueryKey]);

  const viewState = useMemo(() => {
    if (seasonQuery.isLoading || topQuery.isLoading) {
      return 'ranking_loading';
    }

    if (!seasonQuery.data || !topQuery.data) {
      return 'ranking_error';
    }

    if (publication?.state === 'unavailable') return 'ranking_unavailable';
    if (!items.length) return 'ranking_empty';
    if (rankingQuery.isFetchingNextPage) return 'ranking_paginating';
    if (rankType === 'final' || seasonQuery.data.status === 'settled') {
      return 'ranking_settled';
    }
    if (myRanking?.state === 'not_joined' || !seasonQuery.data.joined) {
      return 'ranking_partial_unjoined';
    }

    return 'ranking_ready';
  }, [
    seasonQuery.isLoading,
    seasonQuery.data,
    topQuery.isLoading,
    topQuery.data,
    rankingQuery.isError,
    rankingQuery.data,
    rankingQuery.isFetchingNextPage,
    rankingErrorCode,
    publication?.state,
    items.length,
    rankType,
    myRanking?.state,
  ]);

  if (viewState === 'ranking_loading') {
    return <FullPageLoading message="랭킹을 불러오는 중입니다." />;
  }

  if (viewState === 'ranking_error') {
    return (
      <ErrorState
        title="랭킹을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          void seasonQuery.refetch();
          void topQuery.refetch();
        }}
      />
    );
  }

  if (viewState === 'ranking_unavailable') {
    return (
      <ScrollView refreshControl={refresh.refreshControl} style={styles.container} contentContainerStyle={styles.content}>
        <EmptyState
          title="랭킹 생성 대기 중입니다."
          message="랭킹 스냅샷이 생성되면 이곳에 표시됩니다."
          actionLabel={hasNotJoined ? '시즌 참가하기' : undefined}
          onAction={hasNotJoined ? () => rootNavigation.navigate('SeasonJoin') : undefined}
        />
      </ScrollView>
    );
  }

  const top3 = publication?.rankings ?? [];

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        refreshControl={refresh.refreshControl}
        testID={TEST_IDS.ranking.screen}
        data={rankingErrorCode === ERROR_CODE.RANKING_SNAPSHOT_CHANGED ? [] : items}
        keyExtractor={getRankingItemKey}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (rankingQuery.hasNextPage && !rankingQuery.isFetching) {
            void rankingQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <>
            <MyRankingCard
              me={meQuery.data}
              myRanking={myRanking}
              rankType={rankType}
              viewState={viewState}
              onJoin={() => rootNavigation.navigate('SeasonJoin')}
            />

            <View style={styles.card} testID="ranking-top3">
              <Text style={styles.label}>상위 랭커</Text>
              <View style={[styles.topRow, (width < 360 || fontScale > 1) && styles.topColumn]}>
                {top3.map((item) => (
                  <ActionPressable
                    key={getRankingItemKey(item)}
                    testID={`ranking-top-${item.userId}`}
                    style={styles.topCard}
                    onPress={() =>
                      navigation.navigate('UserSeasonSummary', {
                        userId: item.userId,
                      })
                    }
                  >
                    <Text style={styles.topRank}>#{item.rank}</Text>
                    <ProfileAvatar profileImageUrl={item.profileImageUrl} size={32} testID={`ranking-top-avatar-${item.userId}`} />
                    <Text style={styles.topName}>{item.nickname}</Text>
                    <Text style={styles.helper}>{formatPercent(item.returnRate)}%</Text>
                  </ActionPressable>
                ))}
              </View>
            </View>

            <View style={styles.tabRow}>
              {TABS.map((tab) => {
                const active = tab.key === selectedTab;
                const testID =
                  tab.key === 'all'
                    ? TEST_IDS.ranking.tabAll
                    : tab.key === 'friends'
                    ? TEST_IDS.ranking.tabFriends
                    : TEST_IDS.ranking.tabTop10;

                return (
                  <ActionPressable
                    key={tab.key}
                    testID={testID}
                    accessibilityRole="tab"
                    accessibilityLabel={tab.label}
                    accessibilityState={{ selected: active }}
                    aria-selected={active}
                    style={[styles.tabButton, active && styles.tabButtonActive]}
                    onPress={() => setSelectedTab(tab.key)}
                  >
                    <Text style={active ? styles.tabTextActive : styles.tabText}>
                      {tab.label}
                    </Text>
                  </ActionPressable>
                );
              })}
            </View>
          </>
        }
        ListEmptyComponent={
          rankingQuery.isLoading ? <ActivityIndicator accessibilityLabel="목록을 불러오는 중입니다." /> :
          rankingQuery.isError ? <ErrorState title="목록을 불러오지 못했습니다."
            onRetry={() => {
              void topQuery.refetch().then(() => queryClient.resetQueries({ queryKey: rankingQueryKey, exact: true }));
            }} /> : selectedTab === 'friends' ? (
            <EmptyState
              title="현재 시즌 랭킹에 표시할 친구가 없습니다."
              message="친구를 추가하거나 친구의 시즌 참가를 기다려주세요."
              actionLabel="친구 찾기"
              onAction={() => navigation.navigate('MyTab', { screen: 'Friends' })}
            />
          ) : (
            <EmptyState
              title="아직 랭킹 데이터가 없습니다."
              message="참가자가 쌓이면 랭킹이 표시됩니다."
            />
          )
        }
        renderItem={({ item }) => (
          <RankingRow
            item={item}
            rankType={rankType}
            onPress={() =>
              navigation.navigate('UserSeasonSummary', {
                userId: item.userId,
              })
            }
          />
        )}
        ListFooterComponent={
          rankingQuery.isFetchingNextPage ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function MyRankingCard({
  me,
  myRanking,
  rankType,
  viewState,
  onJoin,
}: {
  me?: MeDto;
  myRanking: MyRankingDto | null;
  rankType?: RankingRankType;
  viewState: string;
  onJoin: () => void;
}) {
  if (myRanking?.state === 'not_joined' || viewState === 'ranking_partial_unjoined') {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>아직 이번 시즌에 참가하지 않았습니다.</Text>
        <Text style={styles.helper}>
          랭킹은 볼 수 있지만 내 순위는 참가 후 반영됩니다.
        </Text>

        <CTAButton label="시즌 참가하기" onPress={onJoin} />
      </View>
    );
  }

  if (myRanking?.state === 'unavailable') {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>내 순위</Text>
        <Text style={styles.helper}>내 랭킹 생성 대기 중입니다.</Text>
      </View>
    );
  }

  const availableRanking = myRanking?.state === 'available' ? myRanking : null;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>내 순위</Text>
      {me ? (
        <View style={styles.myIdentity}>
          <ProfileAvatar profileImageUrl={me.profileImageUrl} size={36} testID="ranking-my-avatar" />
          <Text style={styles.rankIdentity}>{me.nickname}</Text>
        </View>
      ) : null}
      <Text style={styles.big}>
        {availableRanking ? `#${availableRanking.rank}` : '-'}
      </Text>
      <Text style={styles.helper}>
        등급 {getRankingTier(availableRanking, rankType)} · 수익률 {formatPercent(availableRanking?.returnRate)}%
      </Text>
      <Text style={styles.helper}>퍼센타일 {formatPercent(availableRanking?.percentile)}%</Text>
      {rankType === 'final' ? (
        <Text style={styles.settledText}>최종 랭킹 확정</Text>
      ) : null}
    </View>
  );
}

function RankingRow({
  item,
  rankType,
  onPress,
}: {
  item: RankingItemDto;
  rankType?: RankingRankType;
  onPress: () => void;
}) {
  return (
    <ActionPressable
      testID={TEST_IDS.ranking.item(item.userId)}
      style={styles.rankRow}
      onPress={onPress}
    >
      <View style={styles.rankLeft}>
        <Text style={styles.rankNumber}>#{item.rank}</Text>
        <View style={styles.rankIdentity}>
          <ProfileAvatar profileImageUrl={item.profileImageUrl} size={28} testID={`ranking-avatar-${item.userId}`} />
          <Text style={styles.name}>{item.nickname}</Text>
          <Text style={styles.helper}>등급 {getRankingTier(item, rankType)}</Text>
          <Text style={styles.helper}>퍼센타일 {formatPercent(item.percentile)}%</Text>
        </View>
      </View>

      <View style={styles.alignEnd}>
        <Text style={styles.value}>{formatPercent(item.returnRate)}%</Text>
        <Text style={styles.helper}>{formatKrw(item.totalAssetKrw)}원</Text>
      </View>
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 8,
    marginBottom: 12,
  },
  tabRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  tabButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: semantic.raised,
  },
  tabButtonActive: { backgroundColor: semantic.secondaryActionSurface, borderColor: semantic.secondaryActionSurface },
  tabText: { color: semantic.text, fontWeight: '600',
    ...(Platform.OS === 'web' ? { maxWidth: '100%', textAlign: 'center' } as const : {}) },
  tabTextActive: { color: semantic.secondaryActionForeground, fontWeight: '600',
    ...(Platform.OS === 'web' ? { maxWidth: '100%', textAlign: 'center' } as const : {}) },
  title: { fontSize: 22, fontWeight: '700' },
  label: { fontSize: 13, color: semantic.secondary },
  big: { fontSize: 24, fontWeight: '700' },
  helper: { fontSize: 14, color: semantic.secondary },
  settledText: { color: semantic.error, fontWeight: '700' },
  topRow: { flexDirection: 'row', gap: 10 },
  topColumn: { flexDirection: 'column' },
  topCard: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: semantic.raised,
    gap: 4,
  },
  topRank: { fontSize: 16, fontWeight: '700' },
  topName: { fontSize: 14, fontWeight: '600' },
  rankRow: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  rankLeft: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'center',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 160,
    minWidth: 0,
  },
  myIdentity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rankIdentity: { flexGrow: 1, flexShrink: 1, flexBasis: 100, minWidth: 0, gap: 4 },
  rankNumber: { maxWidth: '100%', fontSize: 18, fontWeight: '700' },
  name: { fontSize: 15, fontWeight: '700' },
  value: { fontSize: 15, fontWeight: '700' },
  alignEnd: { alignItems: 'flex-end', flexGrow: 1, flexShrink: 1, minWidth: 0 },
  footerLoader: { paddingVertical: 16 },
});
