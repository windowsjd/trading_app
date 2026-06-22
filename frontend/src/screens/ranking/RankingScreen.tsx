import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  FlatList,
  ActivityIndicator,
} from 'react-native';
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

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';
import CTAButton from '../../components/common/CTAButton';

type Props = RankingScreenProps;

const TABS: Array<{ key: RankingScope; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'near_me', label: '내 주변' },
  { key: 'top10', label: 'TOP10' },
];

function displayValue(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getRankingItemKey(item: RankingItemDto) {
  return (
    item.seasonParticipantId ??
    item.userId ??
    `${item.user.id}-${item.rank}`
  );
}

function getRankTypeLabel(rankType?: RankingRankType) {
  return rankType === 'final' ? '최종 랭킹' : '일간 랭킹';
}

export default function RankingScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();
  const [selectedTab, setSelectedTab] = React.useState<RankingScope>('all');
  const snapshotResetAttemptRef = React.useRef(0);
  const rankingLimit = selectedTab === 'top10' ? 10 : 50;
  const rankingQueryKey = useMemo(
    () =>
      QUERY_KEYS.ranking.list({
        scope: selectedTab,
        limit: rankingLimit,
        offset: 0,
      }),
    [rankingLimit, selectedTab],
  );

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const rankingQuery = useInfiniteQuery({
    queryKey: rankingQueryKey,
    queryFn: ({ pageParam }) =>
      getRankings({
        scope: selectedTab,
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
      rankType: undefined as RankingRankType | undefined,
      rankingDate: null as string | null,
      capturedAt: null as string | null,
    },
    refetchInterval: (query) => {
      const data = query.state.data as
        | { pages?: Array<{ rankType?: RankingRankType }> }
        | undefined;
      const polledRankType = data?.pages?.[0]?.rankType;

      if (polledRankType === 'final' || seasonQuery.data?.status === 'settled') {
        return false;
      }

      return 60_000;
    },
  });

  const firstPage = rankingQuery.data?.pages[0];
  const rankType = firstPage?.rankType;

  const items = useMemo(() => {
    const byKey = new Map<string, RankingItemDto>();

    rankingQuery.data?.pages.forEach((page) => {
      page.rankings.forEach((item) => {
        byKey.set(getRankingItemKey(item), item);
      });
    });

    return Array.from(byKey.values());
  }, [rankingQuery.data]);

  const myRanking = firstPage?.myRanking ?? null;
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
    firstPage?.rankingDate,
    firstPage?.capturedAt,
    rankType,
  ]);

  React.useEffect(() => {
    if (rankingErrorCode !== ERROR_CODE.RANKING_SNAPSHOT_CHANGED) return;
    if (snapshotResetAttemptRef.current > 0) return;

    snapshotResetAttemptRef.current += 1;
    void queryClient
      .resetQueries({ queryKey: rankingQueryKey, exact: true })
      .then(() => rankingQuery.refetch());
  }, [queryClient, rankingErrorCode, rankingQuery.refetch, rankingQueryKey]);

  const viewState = useMemo(() => {
    if (seasonQuery.isLoading || rankingQuery.isLoading) {
      return 'ranking_loading';
    }

    if (rankingErrorCode === ERROR_CODE.RANKING_SNAPSHOT_CHANGED) {
      return snapshotResetAttemptRef.current > 0
        ? 'ranking_snapshot_changed'
        : 'ranking_loading';
    }

    if (seasonQuery.isError || !seasonQuery.data || rankingQuery.isError) {
      return 'ranking_error';
    }

    if (firstPage?.state === 'unavailable') return 'ranking_unavailable';
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
    seasonQuery.isError,
    seasonQuery.data,
    rankingQuery.isLoading,
    rankingQuery.isError,
    rankingQuery.isFetchingNextPage,
    rankingErrorCode,
    firstPage?.state,
    items.length,
    rankType,
    myRanking?.state,
  ]);

  if (viewState === 'ranking_loading') {
    return <FullPageLoading message="랭킹을 불러오는 중입니다." />;
  }

  if (viewState === 'ranking_snapshot_changed') {
    return (
      <ErrorState
        title="랭킹이 갱신되었습니다."
        message="최신 스냅샷 기준으로 다시 불러와주세요."
        onRetry={() => {
          void queryClient
            .resetQueries({ queryKey: rankingQueryKey, exact: true })
            .then(() => rankingQuery.refetch());
        }}
      />
    );
  }

  if (viewState === 'ranking_error') {
    return (
      <ErrorState
        title="랭킹을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          seasonQuery.refetch();
          rankingQuery.refetch();
        }}
      />
    );
  }

  if (viewState === 'ranking_unavailable') {
    return (
      <EmptyState
        title="랭킹 생성 대기 중입니다."
        message="랭킹 스냅샷이 생성되면 이곳에 표시됩니다."
      />
    );
  }

  if (viewState === 'ranking_empty') {
    return (
      <EmptyState
        title="아직 랭킹 데이터가 없습니다."
        message="참가자가 쌓이면 랭킹이 표시됩니다."
      />
    );
  }

  const top3 = items.slice(0, 3);

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.ranking.screen}
        data={items}
        keyExtractor={getRankingItemKey}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (rankingQuery.hasNextPage && !rankingQuery.isFetchingNextPage) {
            rankingQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <>
            <MyRankingCard
              myRanking={myRanking}
              rankType={rankType}
              viewState={viewState}
              onJoin={() => rootNavigation.navigate('SeasonJoin')}
            />

            <View style={styles.card}>
              <Text style={styles.label}>{getRankTypeLabel(rankType)}</Text>
              <Text style={styles.helper}>
                기준일 {displayValue(firstPage?.rankingDate)} · 캡처 {displayValue(firstPage?.capturedAt)}
              </Text>
            </View>

            {selectedTab !== 'near_me' && top3.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.label}>상위 랭커</Text>
                <View style={styles.topRow}>
                  {top3.map((item) => (
                    <Pressable
                      key={getRankingItemKey(item)}
                      style={styles.topCard}
                      onPress={() =>
                        navigation.navigate('UserSeasonSummary', {
                          userId: item.user.id,
                        })
                      }
                    >
                      <Text style={styles.topRank}>#{item.rank}</Text>
                      <Text style={styles.topName}>{item.user.nickname}</Text>
                      <Text style={styles.helper}>{item.returnRate}%</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.tabRow}>
              {TABS.map((tab) => {
                const active = tab.key === selectedTab;
                const testID =
                  tab.key === 'all'
                    ? TEST_IDS.ranking.tabAll
                    : tab.key === 'near_me'
                    ? TEST_IDS.ranking.tabNearMe
                    : TEST_IDS.ranking.tabTop10;

                return (
                  <Pressable
                    key={tab.key}
                    testID={testID}
                    style={[styles.tabButton, active && styles.tabButtonActive]}
                    onPress={() => setSelectedTab(tab.key)}
                  >
                    <Text style={active ? styles.tabTextActive : styles.tabText}>
                      {tab.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        }
        renderItem={({ item }) => (
          <RankingRow
            item={item}
            rankType={rankType}
            onPress={() =>
              navigation.navigate('UserSeasonSummary', {
                userId: item.user.id,
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
  myRanking,
  rankType,
  viewState,
  onJoin,
}: {
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

  return (
    <View style={styles.card}>
      <Text style={styles.label}>내 순위</Text>
      <Text style={styles.big}>
        {myRanking?.rank ? `#${myRanking.rank}` : '-'}
      </Text>
      <Text style={styles.helper}>
        등급 {getRankingTier(myRanking, rankType)} · 수익률 {displayValue(myRanking?.returnRate)}%
      </Text>
      <Text style={styles.helper}>퍼센타일 {displayValue(myRanking?.percentile)}%</Text>
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
    <Pressable
      testID={TEST_IDS.ranking.item(item.user.id)}
      style={styles.rankRow}
      onPress={onPress}
    >
      <View style={styles.rankLeft}>
        <Text style={styles.rankNumber}>#{item.rank}</Text>
        <View>
          <Text style={styles.name}>{item.user.nickname}</Text>
          <Text style={styles.helper}>등급 {getRankingTier(item, rankType)}</Text>
          <Text style={styles.helper}>퍼센타일 {displayValue(item.percentile)}%</Text>
        </View>
      </View>

      <View style={styles.alignEnd}>
        <Text style={styles.value}>{item.returnRate}%</Text>
        <Text style={styles.helper}>{item.totalAssetKrw} KRW</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
    marginBottom: 12,
  },
  tabRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  tabButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  tabButtonActive: { backgroundColor: '#111', borderColor: '#111' },
  tabText: { color: '#111', fontWeight: '600' },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  title: { fontSize: 22, fontWeight: '700' },
  label: { fontSize: 13, color: '#666' },
  big: { fontSize: 24, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  settledText: { color: '#c62828', fontWeight: '700' },
  topRow: { flexDirection: 'row', gap: 10 },
  topCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#fff',
    gap: 4,
  },
  topRank: { fontSize: 16, fontWeight: '700' },
  topName: { fontSize: 14, fontWeight: '600' },
  rankRow: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  rankLeft: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  rankNumber: { fontSize: 18, fontWeight: '700' },
  name: { fontSize: 15, fontWeight: '700' },
  value: { fontSize: 15, fontWeight: '700' },
  alignEnd: { alignItems: 'flex-end' },
  footerLoader: { paddingVertical: 16 },
});
