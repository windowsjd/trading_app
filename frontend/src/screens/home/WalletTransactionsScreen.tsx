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

import type { WalletTransactionsScreenProps } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getWalletTransactions,
  type WalletCurrency,
  type WalletTransactionDirection,
  type WalletTransactionDto,
} from '../../features/wallet/api';
import { formatCurrency } from '../../utils/format';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';

type Props = WalletTransactionsScreenProps;
type CurrencyFilter = 'all' | WalletCurrency;
type DirectionFilter = 'all' | WalletTransactionDirection;
type TxTypeFilter = 'all' | string;

const PAGE_SIZE = 20;

const CURRENCY_FILTERS: Array<{ key: CurrencyFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'KRW', label: 'KRW' },
  { key: 'USD', label: 'USD' },
];

const DIRECTION_FILTERS: Array<{ key: DirectionFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'credit', label: '입금' },
  { key: 'debit', label: '출금' },
];

const TX_TYPE_FILTERS: Array<{ key: TxTypeFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'season_join', label: '시즌 참가' },
  { key: 'fx_execute', label: '환전' },
  { key: 'exchange', label: '환전' },
  { key: 'order', label: '주문' },
  { key: 'order_fill', label: '주문 체결' },
  { key: 'fee', label: '수수료' },
  { key: 'adjustment', label: '조정' },
];

const TX_TYPE_LABELS: Record<string, string> = {
  season_join: '시즌 참가',
  season_reward: '시즌 보상',
  fx_quote: '환전 견적',
  fx_execute: '환전',
  exchange: '환전',
  order: '주문',
  order_fill: '주문 체결',
  fee: '수수료',
  adjustment: '조정',
  deposit: '입금',
  withdraw: '출금',
  withdrawal: '출금',
};

function getTransactionKey(item: WalletTransactionDto) {
  return item.transactionId;
}

function displayValue(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getDirectionLabel(direction: WalletTransactionDirection) {
  return direction === 'credit' ? '입금' : '출금';
}

function getTxTypeLabel(txType?: string | null) {
  if (!txType) return '기타';

  const normalized = txType.trim().toLowerCase();
  return TX_TYPE_LABELS[normalized] ?? txType;
}

function formatOccurredAt(value?: string | null) {
  if (!value) return '-';

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;

  return new Date(timestamp).toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getSignedAmount(item: WalletTransactionDto) {
  const sign = item.direction === 'credit' ? '+' : '-';
  return `${sign}${formatCurrency(item.amount, item.currencyCode)} ${item.currencyCode}`;
}

export default function WalletTransactionsScreen({ route }: Props) {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>(
    route.params?.currencyCode ?? 'all',
  );
  const [directionFilter, setDirectionFilter] =
    useState<DirectionFilter>('all');
  const [txTypeFilter, setTxTypeFilter] = useState<TxTypeFilter>('all');

  const currency = currencyFilter === 'all' ? undefined : currencyFilter;
  const direction = directionFilter === 'all' ? undefined : directionFilter;
  const txType = txTypeFilter === 'all' ? undefined : txTypeFilter;

  const transactionsQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.wallet.transactions({
      currency,
      direction,
      txType,
      limit: PAGE_SIZE,
      offset: 0,
    }),
    queryFn: ({ pageParam }) =>
      getWalletTransactions({
        currency,
        direction,
        txType,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
  });

  const items = useMemo(() => {
    const byId = new Map<string, WalletTransactionDto>();

    transactionsQuery.data?.pages.forEach((page) => {
      page.items.forEach((item) => {
        byId.set(item.transactionId, item);
      });
    });

    return Array.from(byId.values());
  }, [transactionsQuery.data]);

  if (transactionsQuery.isLoading) {
    return <FullPageLoading message="지갑 원장을 불러오는 중입니다." />;
  }

  if (transactionsQuery.isError) {
    return (
      <ErrorState
        title="지갑 원장을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => transactionsQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.walletTransactions.screen}
        data={items}
        keyExtractor={getTransactionKey}
        contentContainerStyle={styles.content}
        refreshing={
          transactionsQuery.isRefetching &&
          !transactionsQuery.isFetchingNextPage
        }
        onRefresh={() => transactionsQuery.refetch()}
        onEndReached={() => {
          if (
            transactionsQuery.hasNextPage &&
            !transactionsQuery.isFetchingNextPage
          ) {
            transactionsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>지갑 원장</Text>

            <View style={styles.filterGroup}>
              <Text style={styles.label}>통화</Text>
              <View style={styles.filterRow}>
                {CURRENCY_FILTERS.map((filter) => (
                  <FilterChip
                    key={filter.key}
                    active={currencyFilter === filter.key}
                    label={filter.label}
                    onPress={() => setCurrencyFilter(filter.key)}
                  />
                ))}
              </View>
            </View>

            <View style={styles.filterGroup}>
              <Text style={styles.label}>방향</Text>
              <View style={styles.filterRow}>
                {DIRECTION_FILTERS.map((filter) => (
                  <FilterChip
                    key={filter.key}
                    active={directionFilter === filter.key}
                    label={filter.label}
                    onPress={() => setDirectionFilter(filter.key)}
                  />
                ))}
              </View>
            </View>

            <View style={styles.filterGroup}>
              <Text style={styles.label}>유형</Text>
              <View style={styles.filterRow}>
                {TX_TYPE_FILTERS.map((filter) => (
                  <FilterChip
                    key={filter.key}
                    active={txTypeFilter === filter.key}
                    label={filter.label}
                    onPress={() => setTxTypeFilter(filter.key)}
                  />
                ))}
              </View>
            </View>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="원장 내역이 없습니다."
            message="해당 조건의 지갑 거래 내역이 없습니다."
          />
        }
        renderItem={({ item }) => (
          <View
            testID={TEST_IDS.walletTransactions.item(getTransactionKey(item))}
            style={styles.rowCard}
          >
            <View style={styles.rowTop}>
              <View style={styles.rowTitleWrap}>
                <Text style={styles.itemTitle}>
                  {getTxTypeLabel(item.txType)}
                </Text>
                <Text style={styles.helper}>
                  {item.currencyCode} · {getDirectionLabel(item.direction)}
                </Text>
              </View>
              <Text
                style={[
                  styles.amount,
                  item.direction === 'credit'
                    ? styles.creditAmount
                    : styles.debitAmount,
                ]}
              >
                {getSignedAmount(item)}
              </Text>
            </View>

            <View style={styles.rowBottom}>
              <View>
                <Text style={styles.helper}>
                  잔액 {formatCurrency(item.balanceAfter, item.currencyCode)} {item.currencyCode}
                </Text>
                <Text style={styles.helper}>
                  {formatOccurredAt(item.occurredAt)}
                </Text>
              </View>
              {item.referenceType ? (
                <Text style={styles.reference} numberOfLines={1}>
                  {item.referenceType}
                </Text>
              ) : null}
            </View>
          </View>
        )}
        ListFooterComponent={
          transactionsQuery.isFetchingNextPage ? (
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
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
    >
      <Text style={active ? styles.chipTextActive : styles.chipText}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 24 },
  header: {
    gap: 14,
    marginBottom: 14,
  },
  title: { fontSize: 24, fontWeight: '700' },
  label: { fontSize: 13, color: '#666' },
  filterHint: { fontSize: 12, color: '#777' },
  filterGroup: { gap: 8 },
  filterRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
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
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowTitleWrap: { flex: 1 },
  rowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  amount: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'right',
  },
  creditAmount: { color: '#166534' },
  debitAmount: { color: '#b91c1c' },
  reference: {
    flexShrink: 1,
    color: '#777',
    fontSize: 12,
    textAlign: 'right',
  },
  footerLoader: { paddingVertical: 16 },
});
