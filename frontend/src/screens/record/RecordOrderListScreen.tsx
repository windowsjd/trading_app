import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RecordStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getMySeasonOrders,
  getRecordOrderDisplay,
} from '../../features/record/api';
import { cancelOrder } from '../../features/order/api';
import {
  getApiErrorCode,
  getErrorMessageFromCode,
} from '../../services/api/errorMapper';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';

type Props = NativeStackScreenProps<RecordStackParamList, 'RecordOrderList'>;
type Filter = 'all' | 'buy' | 'sell';

export default function RecordOrderListScreen({ route }: Props) {
  const { seasonId } = route.params;
  const [filter, setFilter] = useState<Filter>('all');
  const queryClient = useQueryClient();
  const [cancelingOrderId, setCancelingOrderId] = useState<string | null>(null);

  const side = filter === 'all' ? undefined : filter;

  const cancelMutation = useMutation({
    mutationFn: cancelOrder,
    retry: false,
    onSuccess: async () => {
      setCancelingOrderId(null);
      // The released reservation affects wallets/home/portfolio, and the
      // canceled state must show up across order/record lists.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.record.all }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wallet.balances }),
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.wallet.transactionsAll,
        }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.home.dashboard }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.portfolio.all }),
      ]);
    },
    onError: (error) => {
      setCancelingOrderId(null);
      const code = getApiErrorCode(error);
      Alert.alert('주문 취소 실패', getErrorMessageFromCode(code));
    },
  });

  const confirmCancel = (orderId: string, label: string) => {
    Alert.alert(
      '지정가 주문 취소',
      `${label} 주문을 취소할까요? 예약된 금액은 다시 사용할 수 있게 됩니다.`,
      [
        { text: '유지', style: 'cancel' },
        {
          text: '주문 취소',
          style: 'destructive',
          onPress: () => {
            setCancelingOrderId(orderId);
            cancelMutation.mutate(orderId);
          },
        },
      ],
    );
  };

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
          const isCanceling =
            cancelMutation.isPending && cancelingOrderId === display.orderId;

          return (
            <Pressable
              testID={TEST_IDS.record.orderItem(display.key)}
              style={styles.rowCard}
            >
              <View style={styles.rowBody}>
                <View>
                  <Text style={styles.itemTitle}>{display.name}</Text>
                  <Text style={styles.helper}>{display.symbol}</Text>
                  <Text style={styles.helper}>
                    {display.isOpenLimitBuy
                      ? display.submittedAt
                      : display.executedAt}
                  </Text>
                  <Text style={styles.helper}>
                    {display.isLimitOrder
                      ? display.side === 'buy'
                        ? '지정가 매수'
                        : '지정가 매도'
                      : display.side === 'buy'
                      ? '매수'
                      : '매도'}
                    {display.statusLabel ? ` · ${display.statusLabel}` : ''}
                  </Text>
                </View>

                <View style={styles.alignEnd}>
                  <Text style={styles.helper}>수량 {display.quantity}</Text>
                  <Text style={styles.helper}>
                    가격 {display.isLimitOrder && display.limitPrice
                      ? display.limitPrice
                      : display.price}{' '}
                    {display.currencyCode}
                  </Text>
                  {display.reservedAmount && display.isOpenLimitBuy ? (
                    <Text style={styles.helper}>
                      예약금 {display.reservedAmount}
                    </Text>
                  ) : null}
                  <Text style={styles.itemTitle}>{display.netAmount}</Text>
                </View>
              </View>

              {display.isOpenLimitBuy && display.orderId ? (
                <Pressable
                  testID={TEST_IDS.record.orderCancel(display.key)}
                  style={[
                    styles.cancelButton,
                    isCanceling && styles.cancelButtonDisabled,
                  ]}
                  disabled={isCanceling}
                  onPress={() =>
                    confirmCancel(display.orderId as string, display.name)
                  }
                >
                  <Text style={styles.cancelButtonText}>
                    {isCanceling ? '취소 중...' : '주문 취소'}
                  </Text>
                </Pressable>
              ) : null}
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
    marginBottom: 10,
    gap: 12,
  },
  rowBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cancelButton: {
    borderWidth: 1,
    borderColor: '#c62828',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  cancelButtonDisabled: {
    borderColor: '#ddd',
  },
  cancelButtonText: {
    color: '#c62828',
    fontWeight: '700',
  },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  alignEnd: { alignItems: 'flex-end' },
  footerLoader: { paddingVertical: 16 },
});
