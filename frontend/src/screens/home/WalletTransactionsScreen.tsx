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
  type WalletCurrency,
} from '../../features/wallet/api';
import { getTradingAccountWalletTransactions } from '../../features/tradingAccount/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';
import {
  compatibleLedgerType,
  getLedgerRowDisplay,
  getLedgerTypeFilters,
  mergeLedgerPages,
  type LedgerDirection,
  type LedgerType,
} from '../../features/wallet/transactions';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';

type Props = WalletTransactionsScreenProps;


const PAGE_SIZE = 20;

const CURRENCY_FILTERS: Array<{ key: WalletCurrency; label: string }> = [
  { key: 'KRW', label: 'KRW' },
  { key: 'USD', label: 'USD' },
];

const DIRECTION_FILTERS: Array<{ key: LedgerDirection; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'credit', label: '입금' },
  { key: 'debit', label: '출금' },
];

export default function WalletTransactionsScreen({ route }: Props) {
  // The ledger belongs to ONE account (작업 10 §A-4). Reads are status-blind by
  // contract, so a closed or suspended account's history stays fully readable.
  const {
    selectedAccountId,
    selectedAccount,
    isLoading: accountsLoading,
    isEmpty: noAccounts,
  } = useTradingAccount();
  const accountId = selectedAccountId ?? '';
  const hasAccount = !!selectedAccountId;
  const accountDisplay = selectedAccount
    ? getAccountDisplay(selectedAccount)
    : null;

  const [filters, setFilters] = useState<{
    currency: WalletCurrency;
    direction: LedgerDirection;
    txType: LedgerType;
  }>({ currency: route.params?.currencyCode ?? 'KRW', direction: 'all', txType: 'all' });
  const mode = selectedAccount?.mode;
  // Also derive the valid type before querying when the selected account changes.
  const selectedType = compatibleLedgerType(filters.txType, filters.direction, mode, filters.currency);
  const typeFilters = getLedgerTypeFilters(filters.direction, mode, filters.currency);
  const currency = filters.currency;
  const direction = filters.direction === 'all' ? undefined : filters.direction;
  const txType = selectedType === 'all' ? undefined : selectedType;
  const changeDirection = (next: LedgerDirection) => setFilters((current) => ({
    ...current,
    direction: next,
    txType: compatibleLedgerType(current.txType, next, mode, current.currency),
  }));
  const changeCurrency = (next: WalletCurrency) => setFilters((current) => ({
    ...current,
    currency: next,
    txType: compatibleLedgerType(current.txType, current.direction, mode, next),
  }));

  const transactionsQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.tradingAccount.walletTransactions(accountId, {
      currency,
      direction,
      txType,
      limit: PAGE_SIZE,
    }),
    queryFn: ({ pageParam }) =>
      getTradingAccountWalletTransactions(accountId, {
        currency,
        direction,
        txType,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
    enabled: hasAccount,
  });

  const items = useMemo(
    () => mergeLedgerPages(transactionsQuery.data?.pages ?? []),
    [transactionsQuery.data],
  );

  if (accountsLoading || (hasAccount && transactionsQuery.isLoading)) {
    return <FullPageLoading message="지갑 원장을 불러오는 중입니다." />;
  }

  if (noAccounts || !hasAccount) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <AccountSwitcher />
        </View>
      </SafeAreaView>
    );
  }

  // Ledger damage is not an unreachable ledger (작업 12 §3): an empty or partial
  // transaction list would understate what actually moved through this wallet.
  const integrityFailure = findAccountIntegrityFailure([
    {
      section: '지갑 원장',
      isError: transactionsQuery.isError,
      error: transactionsQuery.error,
      retry: () => void transactionsQuery.refetch(),
    },
  ]);

  if (integrityFailure) {
    return (
      <ErrorState
        title={ACCOUNT_INTEGRITY_TITLE}
        message={integrityFailure.message}
        onRetry={integrityFailure.retry}
      />
    );
  }

  if (transactionsQuery.isError) {
    return (
      <ErrorState
        title="지갑 원장을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void transactionsQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.walletTransactions.screen}
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshing={
          transactionsQuery.isRefetching &&
          !transactionsQuery.isFetchingNextPage
        }
        onRefresh={() => void transactionsQuery.refetch()}
        onEndReached={() => {
          if (
            transactionsQuery.hasNextPage &&
            !transactionsQuery.isFetchingNextPage
          ) {
            void transactionsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>지갑 원장</Text>
            {/* Whose ledger this is. Without it, two accounts' histories are
                indistinguishable once the numbers are on screen. */}
            {accountDisplay ? (
              <Text style={styles.accountHeader}>
                {accountDisplay.title} · {accountDisplay.statusLabel}
              </Text>
            ) : null}

            <View style={styles.filterGroup}>
              <Text style={styles.label}>통화</Text>
              <View style={styles.filterRow}>
                {CURRENCY_FILTERS.map((filter) => (
                  <FilterChip
                    key={filter.key}
                    active={currency === filter.key}
                    label={filter.label}
                    onPress={() => changeCurrency(filter.key)}
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
                    active={filters.direction === filter.key}
                    label={filter.label}
                    onPress={() => changeDirection(filter.key)}
                  />
                ))}
              </View>
            </View>

            <View style={styles.filterGroup}>
              <Text style={styles.label}>유형</Text>
              <View style={styles.filterRow}>
                {typeFilters.map((filter) => (
                  <FilterChip
                    key={filter.key}
                    active={selectedType === filter.key}
                    label={filter.label}
                    onPress={() => setFilters((current) => ({ ...current, txType: filter.key }))}
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
        renderItem={({ item }) => {
          const display = getLedgerRowDisplay(item);
          return (
            <View testID={TEST_IDS.walletTransactions.item(item.id)} style={styles.rowCard}>
              <Text style={styles.itemTitle}>{display.title}</Text>
              {display.asset ? <Text style={styles.asset}>{display.asset}</Text> : null}
              {display.quantity ? <Text style={styles.asset}>{display.quantity}</Text> : null}
              <Text style={styles.helper}>{item.currencyCode} · {display.direction}</Text>
              {item.txType === 'ad_reward' ? (
                <Text style={styles.helper}>외부 가상자금 유입</Text>
              ) : null}
              <Text style={[styles.amount, item.direction === 'credit' ? styles.creditAmount : styles.debitAmount]}>
                {display.amount}
              </Text>
              <Text style={styles.balance}>{display.balance}</Text>
              <Text style={styles.helper}>{display.date}</Text>
            </View>
          );
        }}
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
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
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
  accountHeader: {
    fontSize: 14,
    fontWeight: '700',
    color: '#333',
    paddingBottom: 8,
    lineHeight: 20,
  },
  content: { padding: 16, paddingBottom: 24 },
  header: {
    gap: 14,
    marginBottom: 14,
  },
  title: { fontSize: 24, fontWeight: '700' },
  label: { fontSize: 13, color: '#666' },
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
  asset: { fontSize: 15, lineHeight: 22, color: '#222', flexShrink: 1 },
  balance: { fontSize: 14, color: '#444', textAlign: 'right' },
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
  footerLoader: { paddingVertical: 16 },
});
