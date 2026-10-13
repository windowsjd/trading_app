import React, { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AppState, Text, View, type AppStateStatus } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import ActionPressable from '../../components/common/ActionPressable';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import ErrorNotice from '../../components/states/ErrorNotice';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  cancelConditionalSellOrder,
  getConditionalSellOrders,
  type ConditionalSellOrderDto,
} from '../../features/conditional/conditionalSellApi';
import {
  SELL_EXECUTION_TYPE_LABEL,
  SELL_TRIGGER_CONDITION_LABEL,
  getConditionalSellCancelPath,
  getConditionalSellEndReason,
  getConditionalSellKindLabel,
  getConditionalSellQuantityNotice,
  getConditionalSellStateLabel,
  isLiveConditionalSell,
} from '../../features/conditional/conditionalSellDisplay';
import {
  assertEndedConditionalSellPage,
  getOpenConditionalSellOrders,
  mergeConditionalSellLists,
} from '../../features/conditional/conditionalSellLists';
import { cancelTradingAccountOrder } from '../../features/tradingAccount/api';
import { invalidateAfterOrderCancel } from '../../features/tradingAccount/invalidation';
import { getApiErrorCode, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { formatDisplayDecimal, formatKstDateTime, getAssetNameDisplay } from '../../utils/format';

/** Ended history page size; the open list is always read completely. */
const ENDED_PAGE = 30;

type Family = 'condition' | 'protection';
type CancelRequest = {
  accountId: string;
  epoch: number;
  row: ConditionalSellOrderDto;
  path: NonNullable<ReturnType<typeof getConditionalSellCancelPath>>;
  seasonUi: boolean;
};

/**
 * The account's SELL intents of one family — conditions, or independent
 * stop-loss/take-profit — with their real state. Each row keeps the user's
 * target apart from what can (or did) really sell. Read and cancel stay
 * available when new registrations are switched off. An intent is canceled
 * while watching/triggered; once it placed a limit sell, that ordinary order
 * is canceled instead. A failed read is an error, never "none".
 */
export default function ConditionalSellOrdersList({ accountId, family, isFocused, seasonUi }: {
  accountId: string;
  family: Family;
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
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const title = family === 'condition' ? '조건주문 매도' : '손절·익절';

  const open = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalSell.open(accountId, family),
    queryFn: ({ signal }) => getOpenConditionalSellOrders(accountId, family, getConditionalSellOrders, signal),
    refetchOnMount: 'always',
    refetchInterval: (state) => isFocused && appState === 'active'
      && (state.state.data?.conditionalOrders.length ?? 0) > 0
      ? 4000 : false,
    refetchIntervalInBackground: false,
  });
  const ended = useInfiniteQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalSell.ended(accountId, family),
    queryFn: async ({ pageParam, signal }) => assertEndedConditionalSellPage(
      accountId,
      family,
      await getConditionalSellOrders(accountId, { state: 'ended', kind: family, limit: ENDED_PAGE, offset: pageParam }, signal),
    ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.pagination.nextOffset ?? undefined,
    refetchOnMount: 'always',
    gcTime: 0,
  });
  const openIds = useRef<Set<string> | null>(null);
  const openData = open.data?.tradingAccountId === accountId ? open.data : undefined;
  useEffect(() => {
    if (!openData) return;
    const ids = new Set(openData.conditionalOrders.map((row) => row.id));
    const previous = openIds.current;
    openIds.current = ids;
    if (previous && [...previous].some((id) => !ids.has(id)))
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.ended(accountId, family) });
  }, [accountId, family, openData, queryClient]);

  const cancel = useMutation({
    mutationFn: async (request: CancelRequest): Promise<unknown> => request.path.kind === 'conditional'
      ? cancelConditionalSellOrder(request.accountId, request.row.id)
      : cancelTradingAccountOrder(request.accountId, request.path.orderId),
    retry: false,
    onSuccess: async (_, request) => {
      if (isCurrent(request)) setFailure(null);
      if (request.path.kind === 'order') await invalidateAfterOrderCancel(queryClient, request.accountId, { seasonUi: request.seasonUi });
      else await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.all(request.accountId) });
    },
    onError: (cause, request) => {
      if (!isCurrent(request)) return;
      setFailure({ cause });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.all(request.accountId) });
    },
  });
  const confirmCancel = (row: ConditionalSellOrderDto, path: CancelRequest['path']) => {
    const request = { accountId: scope.current.accountId, epoch: scope.current.epoch, row, path, seasonUi };
    const name = getAssetNameDisplay(row.asset).primary;
    const kind = getConditionalSellKindLabel(row.kind);
    Alert.alert(
      path.kind === 'conditional' ? `${kind} 매도 설정 취소` : '연결된 지정가 매도 취소',
      path.kind === 'conditional'
        ? `${name} ${kind} 매도 설정을 취소할까요? 감시 중에는 예약된 수량이 없어요.`
        : `${name} ${kind} 설정으로 접수된 지정가 매도를 취소할까요? 예약된 수량은 다시 매도할 수 있게 됩니다.`,
      [
        { text: '유지', style: 'cancel' },
        { text: '취소하기', style: 'destructive', onPress: () => { if (isCurrent(request)) cancel.mutate(request); } },
      ],
    );
  };

  if (open.isError && !openData) {
    return (
      <>
        <InlineEmptyState title={`${title} 설정을 불러오지 못했습니다.`} message="잠시 후 다시 시도해주세요." />
        <ActionPressable testID={`sell-orders-${family}-retry`} accessibilityRole="button" style={styles.button} onPress={() => void open.refetch()}>
          <Text style={styles.buttonText}>다시 시도</Text>
        </ActionPressable>
        <AdminDiagnosticPanel error={open.error} />
      </>
    );
  }
  if (!openData) return <SectionSkeleton lines={3} />;
  const endedPages = ended.data?.pages.filter((page) => page.tradingAccountId === accountId) ?? [];
  const rows = mergeConditionalSellLists(openData.conditionalOrders, endedPages);
  const canceling = cancel.isPending && cancel.variables && isCurrent(cancel.variables) ? cancel.variables.row.id : null;
  const enabled = openData.capabilities[family]?.enabled === true;
  const renderRow = (row: ConditionalSellOrderDto) => {
    const path = getConditionalSellCancelPath(row);
    const name = getAssetNameDisplay(row.asset);
    const currency = row.currencyCode;
    const reason = getConditionalSellEndReason(row);
    const quantityNotice = getConditionalSellQuantityNotice(row);
    const tone = row.state === 'filled' ? styles.success
      : row.state === 'failed' || row.state === 'order_rejected' ? styles.error
      : isLiveConditionalSell(row) || row.state === 'order_pending' ? styles.live : styles.muted;
    const executed = row.order?.executedQuantity ?? row.order?.quantity ?? null;
    return (
      <View key={row.id} testID={`sell-order-${row.id}`} style={styles.row}>
        <View style={styles.titleLine}>
          <Text style={styles.name}>{name.primary}</Text>
          <Text testID={`sell-order-${row.id}-state`} style={[styles.state, tone]}>{getConditionalSellStateLabel(row.state)}</Text>
        </View>
        <Text style={styles.kind}>매도 · {getConditionalSellKindLabel(row.kind)}</Text>
        <Text style={styles.label}>
          감시가격 {formatDisplayDecimal(row.triggerPrice)} {currency} {SELL_TRIGGER_CONDITION_LABEL[row.triggerCondition] ?? ''} 시{' '}
          {row.executionType === 'limit' && row.limitPrice
            ? `지정가 ${formatDisplayDecimal(row.limitPrice)} ${currency}`
            : SELL_EXECUTION_TYPE_LABEL[row.executionType] ?? ''} 매도
        </Text>
        <Text style={styles.label}>
          설정 수량 {formatDisplayDecimal(row.quantity)}{' · '}등록 {formatKstDateTime(row.createdAt)}
        </Text>
        {quantityNotice ? <Text testID={`sell-order-${row.id}-quantity`} style={styles.notice}>{quantityNotice}</Text> : null}
        {row.trigger ? <Text style={styles.label}>조건 충족 {formatKstDateTime(row.trigger.triggeredAt)}</Text> : null}
        {row.state === 'order_pending' && row.order ? (
          <Text style={styles.label}>
            지정가 {formatDisplayDecimal(row.order.limitPrice)} {currency} 매도 접수 · 예약 수량 {formatDisplayDecimal(row.order.reservedQuantity ?? row.order.quantity)}
          </Text>
        ) : null}
        {row.state === 'filled' && row.order ? (
          <Text style={styles.label}>
            체결 {formatKstDateTime(row.order.executedAt)} · 체결 수량 {formatDisplayDecimal(executed)} · 체결가 {formatDisplayDecimal(row.order.executedPrice)} {currency}
          </Text>
        ) : null}
        {reason ? <Text style={styles.label}>{reason}</Text> : null}
        {path ? (
          <ActionPressable
            testID={`sell-order-${row.id}-cancel`}
            accessibilityRole="button"
            accessibilityState={{ disabled: canceling === row.id, busy: canceling === row.id }}
            disabled={canceling === row.id}
            style={[styles.cancel, canceling === row.id && styles.cancelBusy]}
            onPress={() => confirmCancel(row, path)}
          >
            <Text style={styles.cancelText}>
              {canceling === row.id ? '취소 중...' : path.kind === 'conditional' ? '설정 취소' : '지정가 매도 취소'}
            </Text>
          </ActionPressable>
        ) : null}
      </View>
    );
  };
  const loadingMore = ended.isFetchingNextPage;
  const endedFailed = ended.isError && !ended.isFetchNextPageError;
  return (
    <View style={styles.list} testID={`sell-orders-${family}`}>
      <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text>
      {!enabled ? (
        <Text testID={`sell-orders-${family}-disabled`} style={styles.notice}>
          현재 운영 상태에서는 새 {title} 설정을 등록할 수 없어요. 이미 등록한 설정은 확인하고 취소할 수 있어요.
        </Text>
      ) : null}
      {failure ? (
        <ErrorNotice error={failure.cause} message={getErrorMessageFromCode(getApiErrorCode(failure.cause))}
          testID={`sell-orders-${family}-cancel-error`} style={styles.error} />
      ) : null}
      <View style={styles.section} testID={`sell-orders-${family}-open`}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>진행 중 · {rows.open.length}건</Text>
        {open.isError ? (
          <ErrorNotice error={open.error} message="최신 상태를 확인하지 못했어요. 아래는 마지막으로 확인한 상태예요."
            testID={`sell-orders-${family}-open-stale`} style={styles.notice} />
        ) : null}
        {rows.open.length === 0
          ? <InlineEmptyState title={`진행 중인 ${title} 설정이 없습니다.`} message="감시 중이거나 체결을 기다리는 매도 설정이 여기에 표시돼요." />
          : rows.open.map(renderRow)}
      </View>
      <View style={styles.section} testID={`sell-orders-${family}-ended`}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>종료 이력</Text>
        {endedFailed ? (
          <>
            <ErrorNotice error={ended.error} message="종료 이력을 불러오지 못했습니다."
              testID={`sell-orders-${family}-ended-error`} style={styles.error} />
            <ActionPressable testID={`sell-orders-${family}-ended-retry`} accessibilityRole="button" style={styles.button} onPress={() => void ended.refetch()}>
              <Text style={styles.buttonText}>종료 이력 다시 시도</Text>
            </ActionPressable>
          </>
        ) : null}
        {rows.ended.length > 0 ? rows.ended.map(renderRow)
          : endedFailed ? null
          : !ended.data ? <SectionSkeleton lines={2} />
          : <InlineEmptyState title={`종료된 ${title} 설정이 없습니다.`} message="" />}
        {ended.isFetchNextPageError ? (
          <ErrorNotice error={ended.error} message="이전 이력을 더 불러오지 못했습니다. 다시 눌러 확인해 주세요."
            testID={`sell-orders-${family}-more-error`} style={styles.error} />
        ) : null}
        {ended.data && ended.hasNextPage ? (
          <ActionPressable
            testID={`sell-orders-${family}-more`}
            accessibilityRole="button"
            accessibilityState={{ disabled: loadingMore, busy: loadingMore }}
            disabled={loadingMore}
            style={styles.button}
            onPress={() => { if (!ended.isFetching) void ended.fetchNextPage(); }}
          >
            <Text style={styles.buttonText}>{loadingMore ? '불러오는 중...' : '이전 이력 더 보기'}</Text>
          </ActionPressable>
        ) : null}
      </View>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  list: { gap: 10, minWidth: 0 },
  section: { gap: 10, minWidth: 0 },
  groupTitle: { fontSize: 15, lineHeight: 21, fontWeight: '800', color: semantic.text },
  sectionTitle: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.text },
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
  kind: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: financial.sell },
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
