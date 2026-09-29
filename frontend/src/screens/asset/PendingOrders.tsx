import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import ActionPressable from '../../components/common/ActionPressable';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { formatOrderBookDecimal } from '../../features/asset/orderBook';
import { getRecordOrderDisplay } from '../../features/record/api';
import { getAccountPendingOrders } from '../../features/record/accountOrders';
import { getTradingAccountOrders } from '../../features/tradingAccount/api';
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import { invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation';

type Props = {
  accountId: string;
  isFocused: boolean;
  seasonUi: boolean;
};

export default function PendingOrders({ accountId, isFocused, seasonUi }: Props) {
  const queryClient = useQueryClient();
  const previous = useRef<{ accountId: string; ids: Set<string> }>({
    accountId,
    ids: new Set(),
  });
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.pendingOrders(accountId),
    queryFn: () => getAccountPendingOrders(accountId, getTradingAccountOrders),
    refetchOnMount: 'always',
    refetchInterval: isFocused && appState === 'active' ? 4000 : false,
    refetchIntervalInBackground: false,
  });
  // The account ID is part of the key and checked again at the display boundary.
  const data = query.data?.tradingAccountId === accountId ? query.data : undefined;
  const integrityMessage = query.isError
    ? getIntegrityErrorMessage(query.error)
    : null;

  useEffect(() => {
    if (previous.current.accountId !== accountId) {
      previous.current = { accountId, ids: new Set() };
    }
    if (!data || query.isError) return;
    const ids = new Set(
      data.items
        .map((item) => item.orderId ?? item.id)
        .filter((id): id is string => !!id),
    );
    const disappeared = [...previous.current.ids].some((id) => !ids.has(id));
    previous.current = { accountId, ids };
    if (disappeared) {
      // A status-filtered list cannot tell fill from cancel. Refresh the
      // acting account's financial views after either terminal transition.
      void invalidateAfterOrderCreate(queryClient, accountId, { seasonUi });
    }
  }, [data, query.isError, accountId, queryClient, seasonUi]);

  if (query.isError) {
    return (
      <>
        <InlineEmptyState
          title={
            integrityMessage
              ? '대기 주문을 안전하게 표시할 수 없습니다.'
              : '대기 주문을 불러오지 못했습니다.'
          }
          message={integrityMessage ?? '잠시 후 다시 시도해주세요.'}
        />
        <ActionPressable
          testID="pending-orders-retry"
          accessibilityRole="button"
          style={styles.retry}
          onPress={() => void query.refetch()}
        >
          <Text style={styles.value}>대기 주문 다시 시도</Text>
        </ActionPressable>
        <AdminDiagnosticPanel error={query.error} />
      </>
    );
  }
  if (!data) return <SectionSkeleton lines={4} />;
  if (data.items.length === 0) {
    return <InlineEmptyState title="대기 중인 지정가 주문이 없습니다." message="" />;
  }

  return (
    <View style={styles.list} testID="pending-orders-list">
      <Text style={styles.count}>대기 주문 {data.items.length}건</Text>
      {data.items.map((item) => {
        const display = getRecordOrderDisplay(item);
        const buy = item.side === 'buy';
        return (
          <View
            key={display.key}
            testID={`pending-order-${display.key}`}
            style={styles.row}
          >
            <Text style={styles.name}>{display.name}</Text>
            {display.symbol ? (
              <Text style={styles.label}>{display.symbol}</Text>
            ) : null}
            <Text style={[styles.side, buy ? styles.buy : styles.sell]}>
              지정가 {buy ? '매수' : '매도'} · {display.statusLabel ?? '미체결'}
            </Text>
            <View style={styles.metric}>
              <Text style={styles.label}>지정가</Text>
              <Text selectable style={styles.value}>
                {item.limitPrice
                  ? formatOrderBookDecimal(item.limitPrice)
                  : '-'}
              </Text>
              <Text style={styles.label}>{display.currencyCode}</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.label}>주문 수량</Text>
              <Text selectable style={styles.value}>
                {formatOrderBookDecimal(item.quantity)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10, minWidth: 0 },
  count: { fontSize: 12, color: '#697583' },
  row: {
    borderWidth: 1,
    borderColor: '#edf0f3',
    borderRadius: 12,
    padding: 14,
    gap: 6,
    minWidth: 0,
  },
  name: { fontSize: 17, fontWeight: '700', color: '#202a35', flexShrink: 1 },
  side: { fontSize: 14, fontWeight: '700' },
  buy: { color: BUY_COLOR },
  sell: { color: SELL_COLOR },
  metric: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: 8,
    rowGap: 2,
  },
  label: { fontSize: 13, color: '#697583' },
  value: {
    fontSize: 14,
    color: '#536170',
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    maxWidth: '100%',
  },
  retry: {
    alignSelf: 'flex-start',
    padding: 10,
    borderWidth: 1,
    borderColor: '#dfe4e9',
    borderRadius: 8,
  },
});
