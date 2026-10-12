import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AppState, Text, View, type AppStateStatus } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  cancelConditionalBuyOrder,
  getConditionalBuyOrders,
  type ConditionalBuyOrderDto,
} from '../../features/conditional/conditionalBuyApi';
import {
  EXECUTION_TYPE_LABEL,
  TRIGGER_CONDITION_LABEL,
  getConditionalBuyCancelPath,
  getConditionalBuyEndReason,
  getConditionalBuyStateLabel,
  isLiveConditionalBuy,
} from '../../features/conditional/conditionalBuyDisplay';
import { cancelTradingAccountOrder } from '../../features/tradingAccount/api';
import { invalidateAfterOrderCancel } from '../../features/tradingAccount/invalidation';
import { getApiErrorCode, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { formatDisplayDecimal, formatKstDateTime, getAssetNameDisplay } from '../../utils/format';

const LIST = { history: true, limit: 30 } as const;

type CancelRequest = {
  accountId: string;
  epoch: number;
  row: ConditionalBuyOrderDto;
  path: NonNullable<ReturnType<typeof getConditionalBuyCancelPath>>;
  seasonUi: boolean;
};

/**
 * The account's Conditional BUY watches with their real state. Read and
 * cancel stay available even when new registrations are switched off. A
 * watch is canceled while watching/triggered; once it placed a limit order,
 * that ordinary order is canceled instead (the watch then reads 연결 주문 취소).
 */
export default function ConditionalBuyOrdersList({ accountId, isFocused, seasonUi }: {
  accountId: string;
  isFocused: boolean;
  seasonUi: boolean;
}) {
  const queryClient = useQueryClient();
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);
  const scope = useRef({ accountId, epoch: 0 });
  if (scope.current.accountId !== accountId) scope.current = { accountId, epoch: scope.current.epoch + 1 };
  useEffect(() => () => {
    scope.current = { ...scope.current, epoch: scope.current.epoch + 1 };
  }, []);
  const isCurrent = (request: CancelRequest) =>
    request.accountId === scope.current.accountId && request.epoch === scope.current.epoch;
  const [failure, setFailure] = useState<{ message: string; cause: unknown } | null>(null);

  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.list(accountId, LIST),
    queryFn: ({ signal }) => getConditionalBuyOrders(accountId, LIST, signal),
    refetchOnMount: 'always',
    // Poll only while something can still change state.
    refetchInterval: (state) => isFocused && appState === 'active'
      && state.state.data?.conditionalOrders.some((row) => isLiveConditionalBuy(row) || row.state === 'order_pending')
      ? 4000 : false,
    refetchIntervalInBackground: false,
  });
  const cancel = useMutation({
    mutationFn: async (request: CancelRequest): Promise<unknown> => request.path.kind === 'conditional'
      ? cancelConditionalBuyOrder(request.accountId, request.row.id)
      : cancelTradingAccountOrder(request.accountId, request.path.orderId),
    retry: false,
    onSuccess: async (_, request) => {
      if (isCurrent(request)) setFailure(null);
      if (request.path.kind === 'order') await invalidateAfterOrderCancel(queryClient, request.accountId, { seasonUi: request.seasonUi });
      else await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.all(request.accountId) });
    },
    onError: (cause, request) => {
      if (!isCurrent(request)) return;
      setFailure({ cause, message: getErrorMessageFromCode(getApiErrorCode(cause)) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.all(request.accountId) });
    },
  });
  const confirmCancel = (row: ConditionalBuyOrderDto, path: CancelRequest['path']) => {
    const request = { accountId: scope.current.accountId, epoch: scope.current.epoch, row, path, seasonUi };
    const name = getAssetNameDisplay(row.asset).primary;
    Alert.alert(
      path.kind === 'conditional' ? '조건주문 취소' : '연결된 지정가 주문 취소',
      path.kind === 'conditional'
        ? `${name} 조건주문 감시를 취소할까요? 감시 중에는 예약된 금액이 없어요.`
        : `${name} 조건주문으로 접수된 지정가 매수를 취소할까요? 예약된 금액은 다시 사용할 수 있게 됩니다.`,
      [
        { text: '유지', style: 'cancel' },
        { text: '취소하기', style: 'destructive', onPress: () => { if (isCurrent(request)) cancel.mutate(request); } },
      ],
    );
  };

  const data = query.data?.tradingAccountId === accountId ? query.data : undefined;
  if (query.isError && !data) {
    return (
      <>
        <InlineEmptyState title="조건주문을 불러오지 못했습니다." message="잠시 후 다시 시도해주세요." />
        <ActionPressable testID="conditional-orders-retry" accessibilityRole="button" style={styles.button} onPress={() => void query.refetch()}>
          <Text style={styles.buttonText}>조건주문 다시 시도</Text>
        </ActionPressable>
        <AdminDiagnosticPanel error={query.error} />
      </>
    );
  }
  if (!data) return <SectionSkeleton lines={3} />;
  const rows = data.conditionalOrders;
  const canceling = cancel.isPending && cancel.variables && isCurrent(cancel.variables) ? cancel.variables.row.id : null;
  return (
    <View style={styles.list} testID="conditional-orders-list">
      {!data.capabilities.enabled ? (
        <Text testID="conditional-orders-disabled" style={styles.notice}>
          현재 운영 상태에서는 새 조건주문을 등록할 수 없어요. 이미 등록한 조건주문은 확인하고 취소할 수 있어요.
        </Text>
      ) : null}
      {failure ? (
        <>
          <Text testID="conditional-orders-cancel-error" accessibilityLiveRegion="polite" style={styles.error}>{failure.message}</Text>
          <AdminDiagnosticPanel error={failure.cause} />
        </>
      ) : null}
      {rows.length === 0 ? (
        <InlineEmptyState title="조건주문이 없습니다." message="" />
      ) : rows.map((row) => {
        const path = getConditionalBuyCancelPath(row);
        const name = getAssetNameDisplay(row.asset);
        const currency = row.currencyCode;
        const reason = getConditionalBuyEndReason(row);
        const tone = row.state === 'filled' ? styles.success
          : row.state === 'failed' || row.state === 'order_rejected' ? styles.error
          : isLiveConditionalBuy(row) || row.state === 'order_pending' ? styles.live : styles.muted;
        return (
          <View key={row.id} testID={`conditional-order-${row.id}`} style={styles.row}>
            <View style={styles.titleLine}>
              <Text style={styles.name}>{name.primary}</Text>
              <Text testID={`conditional-order-${row.id}-state`} style={[styles.state, tone]}>{getConditionalBuyStateLabel(row.state)}</Text>
            </View>
            <Text style={styles.label}>
              감시가격 {formatDisplayDecimal(row.triggerPrice)} {currency} {TRIGGER_CONDITION_LABEL[row.triggerCondition] ?? ''} 시{' '}
              {row.executionType === 'limit' && row.limitPrice
                ? `지정가 ${formatDisplayDecimal(row.limitPrice)} ${currency}`
                : EXECUTION_TYPE_LABEL[row.executionType] ?? ''} 매수
            </Text>
            <Text style={styles.label}>
              {row.amount ? `매수 금액 ${formatDisplayDecimal(row.amount)} ${currency}` : `수량 ${formatDisplayDecimal(row.quantity)}`}
              {' · '}등록 {formatKstDateTime(row.createdAt)}
            </Text>
            {row.trigger ? <Text style={styles.label}>조건 충족 {formatKstDateTime(row.trigger.triggeredAt)}</Text> : null}
            {row.state === 'filled' && row.order ? (
              <Text style={styles.label}>
                체결 {formatKstDateTime(row.order.executedAt)} · 체결가 {formatDisplayDecimal(row.order.executedPrice)} {currency}
              </Text>
            ) : null}
            {row.state === 'order_pending' && row.order ? (
              <Text style={styles.label}>
                지정가 {formatDisplayDecimal(row.order.limitPrice)} {currency} 주문 접수 · 예약금 {formatDisplayDecimal(row.order.reservedAmount)} {currency}
              </Text>
            ) : null}
            {reason ? <Text style={styles.label}>{reason}</Text> : null}
            {path ? (
              <ActionPressable
                testID={`conditional-order-${row.id}-cancel`}
                accessibilityRole="button"
                accessibilityState={{ disabled: canceling === row.id, busy: canceling === row.id }}
                disabled={canceling === row.id}
                style={[styles.cancel, canceling === row.id && styles.cancelBusy]}
                onPress={() => confirmCancel(row, path)}
              >
                <Text style={styles.cancelText}>
                  {canceling === row.id ? '취소 중...' : path.kind === 'conditional' ? '감시 취소' : '지정가 주문 취소'}
                </Text>
              </ActionPressable>
            ) : null}
          </View>
        );
      })}
      {data.pagination.nextOffset !== null ? <Text style={styles.label}>최근 {rows.length}건만 표시해요.</Text> : null}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  list: { gap: 10, minWidth: 0 },
  notice: { fontSize: 12, lineHeight: 17, color: semantic.warning },
  error: { fontSize: 12, lineHeight: 17, color: semantic.error },
  row: {
    backgroundColor: semantic.surface,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 14,
    gap: 6,
    minWidth: 0,
  },
  titleLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4 },
  name: { fontSize: 16, lineHeight: 22, fontWeight: '700', color: semantic.text, flexShrink: 1 },
  state: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  live: { color: semantic.info },
  success: { color: semantic.success },
  muted: { color: semantic.muted },
  label: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  cancel: {
    marginTop: 4,
    minHeight: 44,
    borderWidth: 1,
    borderColor: semantic.error,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.raised,
  },
  cancelBusy: { borderColor: semantic.border },
  cancelText: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.error },
  button: {
    backgroundColor: semantic.raised,
    alignSelf: 'flex-start',
    padding: 10,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 8,
  },
  buttonText: { fontSize: 14, color: semantic.secondary },
} as const;
