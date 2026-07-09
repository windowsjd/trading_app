import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RecordStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getMySeasonOrders,
  getRecordOrderDisplay,
} from '../../features/record/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';

type Props = NativeStackScreenProps<RecordStackParamList, 'RecordOrderList'>;
type Filter = 'all' | 'buy' | 'sell';

export default function RecordOrderListScreen({ route }: Props) {
  const { seasonId } = route.params;
  const [filter, setFilter] = useState<Filter>('all');

  const side = filter === 'all' ? undefined : filter;

  const ordersQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.record.seasonOrders({
      seasonId,
      limit: 20,
      offset: 0,
      side,
    }),
    queryFn: ({ pageParam }) =>
      getMySeasonOrders({
        seasonId,
        limit: 20,
        offset: pageParam,
        side,
      }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
  });

  const items = useMemo(
    () => ordersQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [ordersQuery.data],
  );

  const viewState = useMemo(() => {
    if (ordersQuery.isLoading) return 'record_orders_loading';
    if (ordersQuery.isError) return 'record_orders_error';
    if (!items.length) return 'record_orders_empty';
    if (ordersQuery.isFetchingNextPage) return 'record_orders_paginating';
    return 'record_orders_ready';
  }, [
    ordersQuery.isLoading,
    ordersQuery.isError,
    ordersQuery.isFetchingNextPage,
    items.length,
  ]);

  if (viewState === 'record_orders_loading') {
    return <FullPageLoading message="거래 내역을 불러오는 중입니다." />;
  }

  if (viewState === 'record_orders_error') {
    return (
      <ErrorState
        title="거래 내역을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => ordersQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.record.orderListScreen}
        data={items}
        keyExtractor={(item) => getRecordOrderDisplay(item).key}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (ordersQuery.hasNextPage && !ordersQuery.isFetchingNextPage) {
            ordersQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.filterRow}>
            <FilterChip
              testID={TEST_IDS.record.orderFilterAll}
              active={filter === 'all'}
              label="전체"
              onPress={() => setFilter('all')}
            />
            <FilterChip
              testID={TEST_IDS.record.orderFilterBuy}
              active={filter === 'buy'}
              label="매수"
              onPress={() => setFilter('buy')}
            />
            <FilterChip
              testID={TEST_IDS.record.orderFilterSell}
              active={filter === 'sell'}
              label="매도"
              onPress={() => setFilter('sell')}
            />
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="거래 내역이 없습니다."
            message="해당 조건의 거래 내역이 없습니다."
          />
        }
        renderItem={({ item }) => {
          const display = getRecordOrderDisplay(item);

          return (
            <Pressable
              testID={TEST_IDS.record.orderItem(display.key)}
              style={styles.rowCard}
            >
              <View>
                <Text style={styles.itemTitle}>{display.name}</Text>
                <Text style={styles.helper}>{display.symbol}</Text>
                <Text style={styles.helper}>{display.executedAt}</Text>
                <Text style={styles.helper}>
                  {display.side === 'buy' ? '매수' : '매도'}
                </Text>
              </View>

              <View style={styles.alignEnd}>
                <Text style={styles.helper}>수량 {display.quantity}</Text>
                <Text style={styles.helper}>
                  가격 {display.price} {display.currencyCode}
                </Text>
                <Text style={styles.itemTitle}>{display.netAmount}</Text>
              </View>
            </Pressable>
          );
        }}
        ListFooterComponent={
          ordersQuery.isFetchingNextPage ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function FilterChip({
  active,
  label,
  onPress,
  testID,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
    >
      <Text style={active ? styles.chipTextActive : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 24 },
  filterRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chip: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: '#111', borderColor: '#111' },
  chipText: { color: '#111', fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '600' },
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
