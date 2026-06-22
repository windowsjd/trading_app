import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RecordStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getMySeasonExchanges,
  getRecordExchangeDisplay,
} from '../../features/record/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';

type Props = NativeStackScreenProps<RecordStackParamList, 'RecordExchangeList'>;

export default function RecordExchangeListScreen({ route }: Props) {
  const { seasonId } = route.params;

  const exchangesQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.record.seasonExchanges({
      seasonId,
      limit: 20,
      offset: 0,
    }),
    queryFn: ({ pageParam }) =>
      getMySeasonExchanges(seasonId, { limit: 20, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
  });

  const items = useMemo(
    () => exchangesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [exchangesQuery.data],
  );

  const viewState = useMemo(() => {
    if (exchangesQuery.isLoading) return 'record_exchanges_loading';
    if (exchangesQuery.isError) return 'record_exchanges_error';
    if (!items.length) return 'record_exchanges_empty';
    if (exchangesQuery.isFetchingNextPage) return 'record_exchanges_paginating';
    return 'record_exchanges_ready';
  }, [
    exchangesQuery.isLoading,
    exchangesQuery.isError,
    exchangesQuery.isFetchingNextPage,
    items.length,
  ]);

  if (viewState === 'record_exchanges_loading') {
    return <FullPageLoading message="환전 내역을 불러오는 중입니다." />;
  }

  if (viewState === 'record_exchanges_error') {
    return (
      <ErrorState
        title="환전 내역을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => exchangesQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.record.exchangeListScreen}
        data={items}
        keyExtractor={(item) => getRecordExchangeDisplay(item).key}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (exchangesQuery.hasNextPage && !exchangesQuery.isFetchingNextPage) {
            exchangesQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <EmptyState
            title="환전 내역이 없습니다."
            message="해당 시즌에 환전 내역이 없습니다."
          />
        }
        renderItem={({ item }) => {
          const display = getRecordExchangeDisplay(item);

          return (
            <View
              testID={TEST_IDS.record.exchangeItem(display.key)}
              style={styles.rowCard}
            >
              <View>
                <Text style={styles.itemTitle}>{display.direction}</Text>
                <Text style={styles.helper}>{display.executedAt}</Text>
                <Text style={styles.helper}>환율 {display.rate}</Text>
              </View>

              <View style={styles.alignEnd}>
                <Text style={styles.helper}>환전 금액 {display.sourceAmount}</Text>
                <Text style={styles.helper}>
                  수수료 {display.feeAmount} {display.feeCurrency}
                </Text>
                <Text style={styles.itemTitle}>
                  수령 {display.netTargetAmount}
                </Text>
              </View>
            </View>
          );
        }}
        ListFooterComponent={
          exchangesQuery.isFetchingNextPage ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator />
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
  itemTitle: { fontSize: 15, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  alignEnd: { alignItems: 'flex-end' },
  footerLoader: { paddingVertical: 16 },
});
