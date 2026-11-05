import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { AppState, Text, View, type AppStateStatus } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { getAccountPendingOrders } from '../../features/record/accountOrders';
import { cancelTradingAccountOrder, getTradingAccountOrders } from '../../features/tradingAccount/api';
import { invalidateAfterOrderCancel, invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation';
import { cancelConditionalBuyOrder, getConditionalBuyOrders } from '../../features/conditional/conditionalBuyApi';
import { getOpenConditionalBuyOrders } from '../../features/conditional/conditionalBuyLists';
import { cancelConditionalSellOrder, getConditionalSellOrders } from '../../features/conditional/conditionalSellApi';
import { getOpenConditionalSellOrders } from '../../features/conditional/conditionalSellLists';
import { cancelEntryTpSlPlan, getAccountEntryTpSlPlans } from '../../features/conditional/entryTpSlApi';
import { getPendingProtections } from '../../features/conditional/api';
import { tpSlCountSummary } from '../../features/conditional/tpSlModel';
import {
  cancelFuturesConditionalEntry,
  cancelFuturesLimitOrder,
  getFuturesConditionalEntries,
  getFuturesLimitOrders,
} from '../../features/futures/api';
import { cancelFuturesTpSlSetting, getFuturesTpSlSettings } from '../../features/futures/tpSlApi';
import { buildPendingItems, registeredLabel, type PendingCancel, type PendingItem } from '../../features/order/pendingItems';
import { getApiErrorCode, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import { isEntryTpSlMarketSupported } from '../../features/order/orderMethods';
import TpSlButton from '../../features/conditional/tpsl/TpSlButton';
import TpSlSheet, { type TpSlTarget } from '../../features/conditional/tpsl/TpSlSheet';
import PendingFuturesAndProtections from './PendingFuturesAndProtections';
import PendingOrderEditSheet from './PendingOrderEditSheet';
import PendingHistory from './PendingHistory';

type Props = {
  accountId: string;
  isFocused: boolean;
  seasonUi: boolean;
  /** Kept for callers; the list always covers every pending kind (2026-11-05). */
  conditional?: boolean;
};

/**
 * 통합 대기목록 (2026-11-05): every active pending order and setting of the
 * selected account in one list, oldest registration first — Spot limit/LOC
 * orders, conditional BUY/SELL, stop-loss/take-profit, Futures limit and
 * conditional entries, Futures stop-loss/take-profit, and the plans waiting
 * for an entry's fill. No kind groups, filters or per-kind empty cards: one
 * list, one empty state, and that only once every source answered (a failed
 * read is shown as a failure, never as "nothing pending"). Each card can be
 * changed (설정 변경) or canceled (설정 취소); ended rows live behind one
 * 종료 이력 entry. Whole-position OCO protections registered before
 * 2026-10-16 keep their own section below while any is live.
 */
export default function PendingOrders(props: Props) {
  const { selectedAccountId } = useTradingAccount();
  return selectedAccountId === props.accountId
    ? <BoundPendingOrders key={`${props.accountId}:${getSessionGeneration()}`} {...props} />
    : null;
}

const SOURCE_LABEL = {
  spot: '현물 지정가 주문',
  buys: '조건부 매수',
  sellConditions: '조건부 매도',
  sellProtections: '손절가/익절가',
  futuresLimits: '선물 지정가 주문',
  futuresWatches: '선물 조건주문',
  futuresTpSl: '선물 손절가/익절가',
  plans: '체결 후 손절가/익절가',
} as const;
type Source = keyof typeof SOURCE_LABEL;

function useAppActive() {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setState);
    return () => subscription.remove();
  }, []);
  return state === 'active';
}

const LIVE_POLL_MS = 4000;
const IDLE_POLL_MS = 15_000;
/** A source's rows, whatever its list is called (an empty source has nothing that can fill or trigger). */
function rowCount(data: unknown) {
  if (!data || typeof data !== 'object') return 0;
  const value = data as Record<string, unknown>;
  for (const key of ['items', 'conditionalOrders', 'orders', 'entries', 'settings', 'plans']) {
    const rows = value[key];
    if (Array.isArray(rows)) return rows.length;
  }
  return 0;
}

/** The answer of a source for this account only (a late answer for another account is never shown). */
function scoped<T extends { tradingAccountId: string }>(query: UseQueryResult<T>, accountId: string) {
  return query.data?.tradingAccountId === accountId ? query.data : undefined;
}

function BoundPendingOrders({ accountId, isFocused, seasonUi }: Props) {
  const client = useQueryClient();
  const active = useAppActive();
  // Live rows are followed closely; an empty source only looks for rows added elsewhere (another
  // device) — this device's own registrations, changes and cancels refresh at once.
  const every = (data: unknown) => (isFocused && active ? (rowCount(data) ? LIVE_POLL_MS : IDLE_POLL_MS) : false);
  const common = { refetchOnMount: 'always' as const, refetchIntervalInBackground: false };
  const spot = useQuery({ queryKey: QUERY_KEYS.tradingAccount.pendingOrders(accountId), queryFn: () => getAccountPendingOrders(accountId, getTradingAccountOrders), refetchInterval: (query) => every(query.state.data), ...common });
  const buys = useQuery({ queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.open(accountId), queryFn: ({ signal }) => getOpenConditionalBuyOrders(accountId, getConditionalBuyOrders, signal), refetchInterval: (query) => every(query.state.data), ...common });
  const sellConditions = useQuery({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.open(accountId, 'condition'), queryFn: ({ signal }) => getOpenConditionalSellOrders(accountId, 'condition', getConditionalSellOrders, signal), refetchInterval: (query) => every(query.state.data), ...common });
  const sellProtections = useQuery({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.open(accountId, 'protection'), queryFn: ({ signal }) => getOpenConditionalSellOrders(accountId, 'protection', getConditionalSellOrders, signal), refetchInterval: (query) => every(query.state.data), ...common });
  const futuresLimits = useQuery({ queryKey: QUERY_KEYS.tradingAccount.futures.pending(accountId), queryFn: ({ signal }) => getFuturesLimitOrders(accountId, signal), refetchInterval: (query) => every(query.state.data), ...common, retry: false });
  const futuresWatches = useQuery({ queryKey: QUERY_KEYS.tradingAccount.futures.conditionalEntries(accountId, 'open'), queryFn: ({ signal }) => getFuturesConditionalEntries(accountId, 'open', signal), refetchInterval: (query) => every(query.state.data), ...common, retry: false });
  const futuresTpSl = useQuery({ queryKey: QUERY_KEYS.tradingAccount.futures.tpSl(accountId, 'open'), queryFn: ({ signal }) => getFuturesTpSlSettings(accountId, 'open', signal), refetchInterval: (query) => every(query.state.data), ...common, retry: false });
  const plans = useQuery({ queryKey: QUERY_KEYS.tradingAccount.entryTpSl.list(accountId, 'open'), queryFn: ({ signal }) => getAccountEntryTpSlPlans(accountId, 'open', signal), refetchInterval: (query) => every(query.state.data), ...common, retry: false });
  // Live whole-position OCO protections (registration retired 2026-10-16) keep their own section.
  const oco = useQuery({ queryKey: QUERY_KEYS.tradingAccount.protections.pending(accountId), queryFn: ({ signal }) => getPendingProtections(accountId, signal), refetchOnMount: 'always', retry: false });
  const queries: Record<Source, UseQueryResult<{ tradingAccountId: string }>> = { spot, buys, sellConditions, sellProtections, futuresLimits, futuresWatches, futuresTpSl, plans };

  const spotData = scoped(spot, accountId);
  const buysData = scoped(buys, accountId);
  const conditionsData = scoped(sellConditions, accountId);
  const protectionsData = scoped(sellProtections, accountId);
  const futuresLimitsData = scoped(futuresLimits, accountId);
  const futuresWatchesData = scoped(futuresWatches, accountId);
  const futuresTpSlData = scoped(futuresTpSl, accountId);
  const plansData = scoped(plans, accountId);
  const ocoData = oco.data?.tradingAccountId === accountId && 'groups' in oco.data ? oco.data : null;
  const liveOcoGroups = ocoData?.groups.filter((group) => group.status === 'holding' || group.status === 'active') ?? [];
  // An entry order a live OCO protects keeps its sizing: no change offered (the server refuses it).
  const ocoProtectedOrderIds = new Set(liveOcoGroups.flatMap((group) => [group.parentOrderId, group.parentFuturesOrderId].filter((id): id is string => !!id)));
  const items = buildPendingItems({
    spotOrders: spotData?.items,
    conditionalBuys: buysData?.conditionalOrders,
    conditionalBuyLimitAvailable: buysData?.capabilities.canUseLimit,
    conditionalSells: [...(conditionsData?.conditionalOrders ?? []), ...(protectionsData?.conditionalOrders ?? [])],
    conditionalSellLimitAvailable: conditionsData?.capabilities.condition?.canUseLimit,
    futuresLimits: futuresLimitsData?.orders,
    futuresConditionals: futuresWatchesData?.entries,
    futuresTpSl: futuresTpSlData?.settings,
    entryPlans: plansData?.plans,
    ocoProtectedOrderIds,
  });
  const failed = (Object.keys(queries) as Source[]).filter((source) => queries[source].isError);
  const loading = (Object.keys(queries) as Source[]).some((source) => !queries[source].isError && !scoped(queries[source], accountId));

  // An item that left the list filled, triggered or was canceled: refresh what it touched.
  const keys = items.map((item) => item.key).join(',');
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const before = previous.current;
    previous.current = keys;
    if (before === null || before === keys) return;
    const now = new Set(keys.split(','));
    if (before.split(',').some((key) => key && !now.has(key))) {
      void client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) });
      void invalidateAfterOrderCreate(client, accountId, { seasonUi });
    }
  }, [accountId, client, keys, loading, seasonUi]);

  // Commands are bound to this account and session; a late answer never touches another.
  const session = useRef(getSessionGeneration());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const current = () => alive.current && isCurrentSession(session.current);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<PendingItem | null>(null);
  const [tpSlTarget, setTpSlTarget] = useState<TpSlTarget | null>(null);
  const [history, setHistory] = useState(false);

  const refreshAfter = async (cancel: PendingCancel['kind']) => {
    if (cancel === 'order') return invalidateAfterOrderCancel(client, accountId, { seasonUi });
    if (cancel === 'conditional_buy') return client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.all(accountId) });
    if (cancel === 'conditional_sell') return client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.all(accountId) });
    if (cancel === 'entry_plan') return client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.entryTpSl.all(accountId) });
    await Promise.all([
      client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) }),
      client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.entryTpSl.all(accountId) }),
      invalidateAfterOrderCreate(client, accountId, { seasonUi }),
    ]);
  };
  const cancel = async (item: PendingItem) => {
    const target = item.cancel;
    if (!target || busy || !isFocused || !current()) return;
    setBusy(item.key); setFailure(null); setConfirming(null); setNotice(null);
    try {
      if (target.kind === 'order') await cancelTradingAccountOrder(accountId, target.id);
      else if (target.kind === 'conditional_buy') await cancelConditionalBuyOrder(accountId, target.id);
      else if (target.kind === 'conditional_sell') await cancelConditionalSellOrder(accountId, target.id);
      else if (target.kind === 'futures_limit') await cancelFuturesLimitOrder(accountId, target.id);
      else if (target.kind === 'futures_conditional') await cancelFuturesConditionalEntry(accountId, target.id);
      else if (target.kind === 'futures_tp_sl') await cancelFuturesTpSlSetting(accountId, target.id);
      else await cancelEntryTpSlPlan(accountId, target.id);
      if (!current()) return;
      setNotice(`${item.assetName} ${item.typeLabel} 설정을 취소했어요.`);
      await refreshAfter(target.kind);
    } catch (error) {
      if (!current()) return;
      setFailure({ key: item.key, error });
      // A cancel that lost to a fill or a trigger: show the server's state.
      void refreshAfter(target.kind);
    } finally {
      if (current()) setBusy(null);
    }
  };
  const changed = (item: PendingItem) => {
    setEditing(null);
    setNotice(`${item.assetName} ${item.typeLabel} 설정을 변경했어요.`);
    void refreshAfter(item.cancel?.kind ?? 'order');
    if (item.kind === 'spot_limit') void invalidateAfterOrderCreate(client, accountId, { seasonUi });
    if (item.kind === 'entry_plan') void client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.entryTpSl.all(accountId) });
  };
  const planCapabilities = plansData?.capabilities ?? null;
  const planSummary = (entryId: string) => plansData
    ? tpSlCountSummary(plansData.plans.filter((plan) => plan.entryId === entryId || plan.childOrderId === entryId))
    : null;
  const liveOco = liveOcoGroups.length > 0;

  return (
    <View style={styles.list} testID="pending-list">
      {notice ? <Text testID="pending-notice" accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
      {failed.map((source) => {
        const integrity = getIntegrityErrorMessage(queries[source].error);
        return (
        <View key={source} style={styles.failure} testID={`pending-source-error-${source}`}>
          <ErrorNotice error={queries[source].error} message={integrity
            ? `${SOURCE_LABEL[source]}을 안전하게 표시할 수 없어요. ${integrity}`
            : `${SOURCE_LABEL[source]}을 불러오지 못했어요. 아래 목록에 빠진 항목이 있을 수 있어요.`} />
          <ActionPressable testID={`pending-source-retry-${source}`} accessibilityRole="button" style={styles.retry} onPress={() => void queries[source].refetch()}>
            <Text style={styles.retryText}>다시 시도</Text>
          </ActionPressable>
        </View>
        );
      })}
      {items.length ? (
        <Text style={styles.count} testID="pending-count">대기 {items.length}건 · 먼저 등록한 순</Text>
      ) : null}
      {items.map((item) => (
        <PendingCard key={item.key} item={item} busy={busy === item.key} locked={busy !== null}
          confirming={confirming === item.key} failure={failure?.key === item.key ? failure.error : null}
          onEdit={() => { setNotice(null); setEditing(item); }}
          onCancel={() => setConfirming(item.key)} onKeep={() => setConfirming(null)} onConfirm={() => void cancel(item)}
          planSummary={item.plans ? planSummary(item.plans.entryId) : null}
          onPlans={item.plans && (planSummary(item.plans.entryId) || (item.plans.entryType.startsWith('futures_')
            ? planCapabilities?.futures.enabled
            // Spot plans only in the markets the server lists (US with its approved prices).
            : planCapabilities?.spot.enabled && isEntryTpSlMarketSupported(planCapabilities.spot, item.plans.assetType)))
            ? () => setTpSlTarget({ type: 'entry', accountId, entryType: item.plans.entryType, entryId: item.plans.entryId }) : undefined} />
      ))}
      {!items.length && loading ? <SectionSkeleton lines={4} /> : null}
      {!items.length && !loading && !failed.length && !liveOco ? (
        <InlineEmptyState title="대기 중인 주문이 없습니다." message="지정가·조건주문·손절가/익절가를 등록하면 여기에서 한 번에 확인할 수 있어요." />
      ) : null}
      {liveOco ? (
        <View style={styles.legacy} testID="pending-legacy-oco">
          <PendingFuturesAndProtections accountId={accountId} focused={isFocused} seasonUi={seasonUi} protections />
        </View>
      ) : null}
      <ActionPressable testID="pending-history-toggle" accessibilityRole="button" accessibilityState={{ expanded: history }} aria-expanded={history}
        onPress={() => setHistory((value) => !value)} style={styles.historyToggle}>
        <Text style={styles.historyText}>{history ? '종료 이력 닫기' : '종료 이력 보기'}</Text>
      </ActionPressable>
      {history ? <PendingHistory accountId={accountId} isFocused={isFocused} /> : null}
      <PendingOrderEditSheet accountId={accountId} item={isFocused ? editing : null} onClose={() => setEditing(null)} onChanged={changed} />
      <TpSlSheet target={isFocused && tpSlTarget?.accountId === accountId ? tpSlTarget : null} onClose={() => setTpSlTarget(null)} />
    </View>
  );
}

const TONE = { buy: financial.buy, sell: financial.sell, long: financial.buy, short: financial.sell } as const;

function PendingCard({ item, busy, locked, confirming, failure, onEdit, onCancel, onKeep, onConfirm, planSummary, onPlans }: {
  item: PendingItem;
  busy: boolean;
  locked: boolean;
  confirming: boolean;
  failure: unknown;
  onEdit: () => void;
  onCancel: () => void;
  onKeep: () => void;
  onConfirm: () => void;
  planSummary: string | null;
  onPlans?: () => void;
}) {
  const id = `pending-item-${item.key.replace(':', '-')}`;
  return (
    <View style={styles.card} testID={id}>
      <View style={styles.top}>
        <Text style={styles.name}>{item.assetName}</Text>
        <Text style={styles.badge} testID={`${id}-type`}>{item.typeLabel}</Text>
      </View>
      <View style={styles.sub}>
        <Text style={[styles.side, { color: TONE[item.tone] }]}>{item.sideLabel}</Text>
        <Text style={styles.time} testID={`${id}-registered`}>{registeredLabel(item)}</Text>
      </View>
      <View style={styles.rows}>
        {item.rows.map((row) => (
          <View key={row.key} style={styles.row} testID={`${id}-${row.key}`}>
            <Text style={styles.label}>{row.label}</Text>
            <Text style={styles.value} selectable>{row.value}</Text>
          </View>
        ))}
      </View>
      {item.notes.map((note) => <Text key={note} style={styles.note}>{note}</Text>)}
      {'reason' in item.edit ? <Text style={styles.note} testID={`${id}-edit-reason`}>{item.edit.reason}</Text> : null}
      {onPlans ? <TpSlButton testID={`${id}-tp-sl`} summary={planSummary} onPress={onPlans} /> : null}
      {failure ? (
        <ErrorNotice error={failure} message={getErrorMessageFromCode(getApiErrorCode(failure))} testID={`${id}-error`} style={styles.error} />
      ) : null}
      {confirming && item.cancel ? (
        <View style={styles.confirm} testID={`${id}-confirm`}>
          <Text style={styles.confirmText}>{item.cancel.confirm}</Text>
          <View style={styles.actions}>
            <ActionPressable testID={`${id}-keep`} accessibilityRole="button" style={[styles.action, styles.neutral]} onPress={onKeep}>
              <Text style={styles.actionText}>유지</Text>
            </ActionPressable>
            <ActionPressable testID={`${id}-confirm-cancel`} accessibilityRole="button" style={[styles.action, styles.danger]} onPress={onConfirm}>
              <Text style={[styles.actionText, styles.dangerText]}>취소하기</Text>
            </ActionPressable>
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <ActionPressable testID={`${id}-edit`} accessibilityRole="button" accessibilityState={{ disabled: !item.edit.editable || locked }}
            aria-disabled={!item.edit.editable || locked} disabled={!item.edit.editable || locked} onPress={onEdit}
            style={[styles.action, styles.neutral, (!item.edit.editable || locked) && styles.disabled]}>
            <Text style={styles.actionText}>설정 변경</Text>
          </ActionPressable>
          {item.cancel ? (
            <ActionPressable testID={`${id}-cancel`} accessibilityRole="button" accessibilityState={{ disabled: locked, busy }}
              aria-disabled={locked} aria-busy={busy} disabled={locked} onPress={onCancel}
              style={[styles.action, styles.danger, locked && styles.disabled]}>
              <Text style={[styles.actionText, styles.dangerText]}>{busy ? '취소 중...' : '설정 취소'}</Text>
            </ActionPressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  list: { gap: 10, minWidth: 0 },
  count: { fontSize: 12, lineHeight: 17, color: semantic.muted },
  notice: { fontSize: 13, lineHeight: 19, color: semantic.success },
  failure: { gap: 6 },
  retry: { alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: semantic.border, borderRadius: 8, backgroundColor: semantic.raised },
  retryText: { fontSize: 13, color: semantic.secondary },
  card: { backgroundColor: semantic.surface, borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, gap: 8, minWidth: 0 },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 22, fontWeight: '700', color: semantic.text, flexShrink: 1, minWidth: 0 },
  badge: { fontSize: 12, lineHeight: 18, fontWeight: '700', color: semantic.secondary, flexShrink: 0, maxWidth: '45%', textAlign: 'right' },
  sub: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2, minWidth: 0 },
  side: { fontSize: 13, lineHeight: 19, fontWeight: '700', flexShrink: 1 },
  time: { fontSize: 12, lineHeight: 18, color: semantic.muted, flexShrink: 1 },
  rows: { gap: 4, minWidth: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10, rowGap: 2, minWidth: 0 },
  label: { fontSize: 13, lineHeight: 19, color: semantic.muted, minWidth: 64 },
  value: { fontSize: 14, lineHeight: 20, color: semantic.text, flexShrink: 1, minWidth: 0 },
  note: { fontSize: 12, lineHeight: 18, color: semantic.secondary, flexShrink: 1 },
  error: { fontSize: 12, lineHeight: 17, color: semantic.error },
  confirm: { gap: 8, borderRadius: 10, padding: 12, backgroundColor: semantic.raised },
  confirmText: { fontSize: 13, lineHeight: 19, color: semantic.text, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1, minHeight: 44, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  neutral: { borderColor: semantic.border, backgroundColor: semantic.raised },
  danger: { borderColor: semantic.error, backgroundColor: semantic.raised },
  disabled: { opacity: 0.5 },
  actionText: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.text, textAlign: 'center' },
  dangerText: { color: semantic.error },
  legacy: { gap: 10 },
  historyToggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  historyText: { fontSize: 14, color: semantic.secondary },
} as const;
