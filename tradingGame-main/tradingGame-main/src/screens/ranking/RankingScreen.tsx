import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { RankingScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getCurrentSeason } from '../../features/season/api';
import {
  getCurrentRankings,
  getNearMeRankings,
  type RankingScope,
  type RankingItemDto,
} from '../../features/ranking/api';

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

export default function RankingScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const [selectedTab, setSelectedTab] = useState<RankingScope>('all');

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const rankingQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.ranking.current(
      selectedTab === 'top10' ? 'top10' : 'all',
      null,
    ),
    queryFn: ({ pageParam }) =>
      getCurrentRankings({
        scope: selectedTab === 'top10' ? 'top10' : 'all',
        cursor: pageParam ?? null,
        limit: selectedTab === 'top10' ? 10 : 50,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasNext ? lastPage.pageInfo.nextCursor : undefined,
    initialPageParam: null as string | null,
    enabled: selectedTab !== 'near_me',
  });

  const nearMeQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.nearMe(5),
    queryFn: () => getNearMeRankings(5),
    enabled: selectedTab === 'near_me',
  });

  const items = useMemo(() => {
    if (selectedTab === 'near_me') {
      return nearMeQuery.data?.items ?? [];
    }
    return rankingQuery.data?.pages.flatMap((page) => page.items) ?? [];
  }, [selectedTab, nearMeQuery.data, rankingQuery.data]);

  const myRank = useMemo(() => {
    if (selectedTab === 'near_me') return nearMeQuery.data?.myRank ?? null;
    return rankingQuery.data?.pages[0]?.myRank ?? null;
  }, [selectedTab, nearMeQuery.data, rankingQuery.data]);

  const viewState = useMemo(() => {
    const loading =
      seasonQuery.isLoading ||
      (selectedTab === 'near_me' ? nearMeQuery.isLoading : rankingQuery.isLoading);

    if (loading) return 'ranking_loading';

    if (
      !seasonQuery.data ||
      (selectedTab === 'near_me'
        ? nearMeQuery.isError || !nearMeQuery.data
        : rankingQuery.isError || !rankingQuery.data)
    ) {
      return 'ranking_error';
    }

    if (!items.length) return 'ranking_empty';
    if (seasonQuery.data.status === 'settled') return 'ranking_settled';
    if (seasonQuery.data.status === 'active' && !seasonQuery.data.joined) {
      return 'ranking_partial_unjoined';
    }

    return 'ranking_ready';
  }, [
    seasonQuery.isLoading,
    seasonQuery.data,
    selectedTab,
    nearMeQuery.isLoading,
    nearMeQuery.isError,
    nearMeQuery.data,
    rankingQuery.isLoading,
    rankingQuery.isError,
    rankingQuery.data,
    items.length,
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
          seasonQuery.refetch();
          rankingQuery.refetch();
          nearMeQuery.refetch();
        }}
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
        keyExtractor={(item) => `${item.user.id}-${item.rank}`}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (
            selectedTab !== 'near_me' &&
            rankingQuery.hasNextPage &&
            !rankingQuery.isFetchingNextPage
          ) {
            rankingQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <>
            {viewState === 'ranking_partial_unjoined' ? (
              <View style={styles.card}>
                <Text style={styles.title}>아직 이번 시즌에 참가하지 않았습니다.</Text>
                <Text style={styles.helper}>
                  랭킹은 볼 수 있지만 내 순위는 참가 후 반영됩니다.
                </Text>

                <CTAButton
                  label="시즌 참가하기"
                  onPress={() => rootNavigation.navigate('SeasonJoin')}
                />
              </View>
            ) : (
              <View style={styles.card}>
                <Text style={styles.label}>내 순위</Text>
                <Text style={styles.big}>{myRank ? `#${myRank.rank}` : '-'}</Text>
                <Text style={styles.helper}>
                  등급 {myRank?.tier ?? '-'} · 수익률 {myRank?.returnRate ?? '-'}%
                </Text>
                {viewState === 'ranking_settled' ? (
                  <Text style={styles.settledText}>최종 랭킹 확정</Text>
                ) : null}
              </View>
            )}

            {selectedTab !== 'near_me' && top3.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.label}>상위 랭커</Text>
                <View style={styles.topRow}>
                  {top3.map((item) => (
                    <Pressable
                      key={item.user.id}
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
            onPress={() =>
              navigation.navigate('UserSeasonSummary', {
                userId: item.user.id,
              })
            }
          />
        )}
        ListFooterComponent={
          selectedTab !== 'near_me' && rankingQuery.isFetchingNextPage ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function RankingRow({
  item,
  onPress,
}: {
  item: RankingItemDto;
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
          <Text style={styles.helper}>등급 {item.tier}</Text>
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