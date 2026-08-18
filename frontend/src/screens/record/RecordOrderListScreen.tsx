import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  Pressable,
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
} from 'react-native';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useIsFocused } from '@react-navigation/native';

import type { RecordStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getRecordOrderDisplay,
  isOpenLimitBuyOrder,
  shouldPollSubmittedLimitOrders,
} from '../../features/record/api';
import { toRecordOrderItems } from '../../features/record/accountOrders';
import {
  cancelTradingAccountOrder,
  getTradingAccountOrders,
} from '../../features/tradingAccount/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import {
  ACCOUNT_LIST_ERROR_MESSAGE,
  ACCOUNT_LIST_ERROR_TITLE,
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_MISSING_TITLE,
  canQueryRecordOrders,
  resolveRecordOrderAccount,
} from '../../features/record/seasonAccountLookup';
import {
  invalidateAfterOrderCancel,
  invalidateAfterOrderCreate,
} from '../../features/tradingAccount/invalidation';
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
  const recordScope = route.params;
  const isGeneralScope = 'accountId' in recordScope;
  const [filter, setFilter] = useState<Filter>('all');
  const queryClient = useQueryClient();
  const {
    accounts,
    isLoading: accountsLoading,
    isError: accountsError,
    refetchAccounts,
  } = useTradingAccount();

  /**
   * The account is derived from the immutable route subject — a season for a
   * historical season record, or an explicit accountId from General Home —
   * never from whatever account happens to be selected now (작업 10 §A-5).
   *
   * Reads are status-blind by contract, so an ended or settled season's closed
   * account still shows its full history here — read-only, with cancel
   * naturally unavailable because nothing is open.
   *
   * `resolveRecordOrderAccount` separates "the account LIST failed" from "the
   * pinned subject is no longer owned" (작업 12 §5) — two states that were one,
   * with a retry button wired to a query that was disabled.
   */
  const accountLookup = resolveRecordOrderAccount({
    scope: recordScope,
    accounts,
    isLoading: accountsLoading,
    isError: accountsError,
  });
  const recordAccount = accountLookup.account;
  const accountId = recordAccount?.id ?? '';
  const hasAccount = canQueryRecordOrders(accountLookup);
  const accountDisplay = recordAccount ? getAccountDisplay(recordAccount) : null;
  const seasonUi = recordAccount?.mode === 'season';
  const isFocused = useIsFocused();
  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState,
  );
  const previousOpenLimitIds = useRef<Set<string>>(new Set());
  const [cancelingOrderId, setCancelingOrderId] = useState<string | null>(null);

  const side = filter === 'all' ? undefined : filter;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  const cancelMutation = useMutation({
    // Cancel names the account explicitly. The backend classifies a foreign
    // account's order as 404 and the caller's OWN order with a broken scope as
    // a structured 500 — neither is silently swallowed here.
    mutationFn: (orderId: string) =>
      cancelTradingAccountOrder(accountId, orderId),
    retry: false,
    onSuccess: async () => {
      setCancelingOrderId(null);
      // Only THIS account's orders/wallets/portfolio, plus the season record
      // and dashboard views that are keyed by season rather than by account
      // (작업 10 §A-11). Positions are untouched: a cancel never fills.
      await invalidateAfterOrderCancel(queryClient, accountId, {
        seasonUi,
      });
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
      `${label} 주문을 취소할까요? 예약된 금액 또는 수량은 다시 사용할 수 있게 됩니다.`,
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
    queryKey: QUERY_KEYS.tradingAccount.orders(accountId, {
      side,
      limit: 20,
    }),
    queryFn: ({ pageParam }) =>
      getTradingAccountOrders(accountId, {
        side,
        limit: 20,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
    enabled: hasAccount,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const pageItems = pages.flatMap((page) => toRecordOrderItems(page));
      return shouldPollSubmittedLimitOrders({
        isFocused,
        appState,
        items: pageItems,
      })
        ? 4000
        : false;
    },
    refetchIntervalInBackground: false,
  });

  /**
   * De-duplicated by orderId, like the portfolio and ledger lists (작업 10
   * §B-9).
   *
   * This list POLLS every 4s while an open limit order exists, and its
   * pagination is offset-based. An order that fills between two page fetches
   * shifts the window, so the same row can arrive on two pages — which in a
   * FlatList means duplicate keys and a row rendered twice.
   */
  const items = useMemo(() => {
    const byOrderId = new Map<string, ReturnType<typeof toRecordOrderItems>[number]>();

    ordersQuery.data?.pages.forEach((page) => {
      toRecordOrderItems(page).forEach((item) => {
        const key = item.orderId ?? item.id;
        if (key) byOrderId.set(key, item);
      });
    });

    return Array.from(byOrderId.values());
  }, [ordersQuery.data]);

  useEffect(() => {
    const terminalTransitionObserved = items.some((item) => {
      const orderId = item.orderId ?? item.id;
      return (
        Boolean(orderId) &&
        previousOpenLimitIds.current.has(orderId) &&
        !isOpenLimitBuyOrder(item)
      );
    });
    if (terminalTransitionObserved && accountId) {
      // A limit order reached a terminal state while we were polling: it either
      // filled (position + cash changed) or was released. Same account-scoped
      // refresh as a create, so no other account's cache is disturbed.
      void invalidateAfterOrderCreate(queryClient, accountId, {
        seasonUi,
      });
    }
    previousOpenLimitIds.current = new Set(
      items
        .filter(isOpenLimitBuyOrder)
        .map((item) => item.orderId ?? item.id)
        .filter((orderId): orderId is string => Boolean(orderId)),
    );
  }, [items, queryClient, accountId, seasonUi]);

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

  if (
    accountLookup.state === 'loading' ||
    (hasAccount && viewState === 'record_orders_loading')
  ) {
    return <FullPageLoading message="거래 내역을 불러오는 중입니다." />;
  }

  // The account LIST failed. Retrying the orders query would do nothing — it is
  // disabled without an account — so the retry is the account list itself.
  if (accountLookup.state === 'account_list_error') {
    return (
      <ErrorState
        title={ACCOUNT_LIST_ERROR_TITLE}
        message={ACCOUNT_LIST_ERROR_MESSAGE}
        onRetry={() => void refetchAccounts()}
      />
    );
  }

  // The list loaded and contains no account for this season. Not an empty order
  // list — that would claim the user made no trades, which this does not know —
  // and not a foreign-account probe either: the client never tries to tell
  // "someone else's" from "does not exist".
  if (accountLookup.state === 'account_missing') {
    return (
      <ErrorState
        title={
          isGeneralScope
            ? '일반 투자 계정을 찾을 수 없습니다.'
            : ACCOUNT_MISSING_TITLE
        }
        message={
          isGeneralScope
            ? '이 화면이 가리키는 일반 투자 계정이 더 이상 내 계정 목록에 없습니다. 계정 정보를 다시 불러온 뒤에도 같으면 고객센터에 문의해주세요.'
            : ACCOUNT_MISSING_MESSAGE
        }
        onRetry={() => void refetchAccounts()}
      />
    );
  }

  // Damage in the order history is not a transient fetch failure (작업 12 §3).
  const integrityFailure = findAccountIntegrityFailure([
    {
      section: '거래 내역',
      isError: ordersQuery.isError,
      error: ordersQuery.error,
      retry: () => void ordersQuery.refetch(),
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

  if (viewState === 'record_orders_error') {
    return (
      <ErrorState
        title="거래 내역을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void ordersQuery.refetch()}
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
            void ordersQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View>
            {/* Which account owns every order below. The route pins this
                subject, so changing the global account selection elsewhere
                cannot retarget this history or its cancel button. */}
            {accountDisplay ? (
              <Text style={styles.accountHeader}>
                {accountDisplay.title} · {accountDisplay.statusLabel}
              </Text>
            ) : null}
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
                <View style={styles.rowNameColumn}>
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
                    {display.hasNoExecutionResult ? '지정가' : '실제 체결가격'}{' '}
                    {display.hasNoExecutionResult
                      ? (display.limitPrice ?? display.price)
                      : display.price}{' '}
                    {display.currencyCode}
                  </Text>
                  {/* A limit row that never filled (submitted or canceled)
                      has no execution amounts: its headline figure is the
                      reservation, labeled as such. netAmount is an ACTUAL
                      fill result and appears only once the order executed. */}
                  {display.hasNoExecutionResult ? (
                    <Text style={styles.itemTitle}>
                      {display.side === 'buy'
                        ? display.isOpenLimitBuy
                          ? '예약금'
                          : '예약금 (해제)'
                        : display.isOpenLimitBuy
                          ? '예약 수량'
                          : '예약 수량 (해제)'}{' '}
                      {display.side === 'buy'
                        ? (display.reservedAmount ?? '-')
                        : (display.reservedQuantity ?? '-')}
                    </Text>
                  ) : (
                    <>
                      {display.isLimitOrder && display.limitPrice ? (
                        <Text style={styles.helper}>
                          지정가 {display.limitPrice}
                        </Text>
                      ) : null}
                      <Text style={styles.helper}>
                        실제 총액 {display.grossAmount}
                      </Text>
                      <Text style={styles.helper}>
                        실제 수수료 {display.feeAmount}
                      </Text>
                      <Text style={styles.itemTitle}>
                        실제 차감액 {display.netAmount}
                      </Text>
                    </>
                  )}
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
                  onPress={() => confirmCancel(display.orderId, display.name)}
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
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  // A long Korean asset name wraps inside its own column instead of pushing the
  // amount column off the screen (작업 12 §7).
  rowNameColumn: { flex: 1, minWidth: 0 },
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
    textAlign: 'center',
    lineHeight: 21,
  },
  itemTitle: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
  helper: { fontSize: 14, color: '#444', lineHeight: 20 },
  // The amount column keeps its own track: it is the figure the row is about.
  alignEnd: { alignItems: 'flex-end', flexShrink: 0 },
  footerLoader: { paddingVertical: 16 },
});
