import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  Pressable,
} from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { RecordSeasonListScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getCurrentSeason } from '../../features/season/api';
import { getMySeasonRecords } from '../../features/record/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';
import CTAButton from '../../components/common/CTAButton';

type Props = RecordSeasonListScreenProps;

export default function RecordSeasonListScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const recordsQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.record.seasons(null),
    queryFn: ({ pageParam }) => getMySeasonRecords(pageParam ?? null, 20),
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasNext ? lastPage.pageInfo.nextCursor : undefined,
    initialPageParam: null as string | null,
  });

  const items = useMemo(
    () => recordsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [recordsQuery.data],
  );

  const aggregate = useMemo(() => {
    if (!items.length) {
      return {
        seasonCount: 0,
        bestRank: '-',
        bestReturnRate: '-',
        avgReturnRate: '-',
      };
    }

    const bestRank = Math.min(...items.map((item) => item.finalRank));
    const bestReturn = Math.max(...items.map((item) => Number(item.finalReturnRate)));
    const avgReturn =
      items.reduce((acc, item) => acc + Number(item.finalReturnRate), 0) /
      items.length;

    return {
      seasonCount: items.length,
      bestRank: String(bestRank),
      bestReturnRate: bestReturn.toFixed(2),
      avgReturnRate: avgReturn.toFixed(2),
    };
  }, [items]);

  const viewState = useMemo(() => {
    if (recordsQuery.isLoading) return 'record_list_loading';
    if (recordsQuery.isError) return 'record_list_error';
    if (!items.length) return 'record_list_empty';
    return 'record_list_ready';
  }, [recordsQuery.isLoading, recordsQuery.isError, items.length]);

  if (viewState === 'record_list_loading') {
    return <FullPageLoading message="전적 목록을 불러오는 중입니다." />;
  }

  if (viewState === 'record_list_error') {
    return (
      <ErrorState
        title="전적 목록을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => recordsQuery.refetch()}
      />
    );
  }

  if (viewState === 'record_list_empty') {
    return (
      <EmptyState
        title="아직 참여한 시즌이 없습니다."
        message="현재 시즌에 참가하면 전적이 쌓이기 시작합니다."
        actionLabel={
          seasonQuery.data?.status === 'active' && !seasonQuery.data?.joined
            ? '현재 시즌 참가하기'
            : undefined
        }
        onAction={
          seasonQuery.data?.status === 'active' && !seasonQuery.data?.joined
            ? () => rootNavigation.navigate('SeasonJoin')
            : undefined
        }
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.record.seasonListScreen}
        data={items}
        keyExtractor={(item) => item.seasonId}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (recordsQuery.hasNextPage && !recordsQuery.isFetchingNextPage) {
            recordsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.card}>
            <Text style={styles.label}>누적 요약</Text>
            <Text style={styles.helper}>참여 시즌 수 {aggregate.seasonCount}</Text>
            <Text style={styles.helper}>최고 순위 {aggregate.bestRank}</Text>
            <Text style={styles.helper}>최고 수익률 {aggregate.bestReturnRate}%</Text>
            <Text style={styles.helper}>평균 수익률 {aggregate.avgReturnRate}%</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            testID={TEST_IDS.record.seasonItem(item.seasonId)}
            style={styles.rowCard}
            onPress={() =>
              navigation.navigate('RecordSeasonDetail', {
                seasonId: item.seasonId,
              })
            }
          >
            <View>
              <Text style={styles.itemTitle}>{item.seasonName}</Text>
              <Text style={styles.helper}>참가 시각 {item.joinedAt}</Text>
            </View>

            <View style={styles.alignEnd}>
              <Text style={styles.helper}>#{item.finalRank}</Text>
              <Text style={styles.helper}>{item.finalTier}</Text>
              <Text style={styles.itemTitle}>{item.finalReturnRate}%</Text>
            </View>
          </Pressable>
        )}
        ListFooterComponent={
          recordsQuery.isFetchingNextPage ? (
            <View style={styles.footerBox}>
              <CTAButton label="불러오는 중..." state="loading" />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
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
  rowCard: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  label: { fontSize: 13, color: '#666' },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  alignEnd: { alignItems: 'flex-end' },
  footerBox: { marginTop: 12 },
});