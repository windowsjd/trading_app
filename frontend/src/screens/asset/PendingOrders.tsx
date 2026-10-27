import PendingFuturesAndProtections from './PendingFuturesAndProtections';
import ConditionalBuyOrdersList from './ConditionalBuyOrdersList';
import ConditionalSellOrdersList from './ConditionalSellOrdersList';
import FuturesConditionalEntriesList from '../futures/FuturesConditionalEntriesList';
import { EntryTpSlPlansList, FuturesTpSlList } from './TpSlPendingLists';
import { financial } from '../../theme/financialColors';
import { semantic } from '../../theme/tokens';
import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from '../../theme/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ActionPressable from '../../components/common/ActionPressable';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getSessionGeneration } from '../../services/api/sessionOwnership';
import { formatOrderBookDecimal } from '../../features/asset/orderBook';
import { getRecordOrderDisplay } from '../../features/record/api';
import { getAccountPendingOrders } from '../../features/record/accountOrders';
import { getTradingAccountOrders } from '../../features/tradingAccount/api';
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import { invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation';
import TpSlButton from '../../features/conditional/tpsl/TpSlButton';
import TpSlSheet, { type TpSlTarget } from '../../features/conditional/tpsl/TpSlSheet';
import { useEntryTpSlSummaries } from '../../features/conditional/tpsl/useEntryTpSlSummaries';
import { isEntryTpSlMarketSupported } from '../../features/order/orderMethods';
import type { RecordOrderItemDto } from '../../features/record/api';
import { WORD_JOINER, ZERO_WIDTH_SPACE } from '../guide/figureText';

/** The pending row's asset type from its market (KRX, BINANCE, US exchanges). */
function pendingAssetType(market?: string) {
  if (market === 'KRX') return 'domestic_stock';
  if (market === 'BINANCE') return 'crypto';
  if (market === 'NAS' || market === 'NYS' || market === 'AMS') return 'us_stock';
  return null;
}

/**
 * A pending entry that may take 손절가/익절가 plans: an ordinary BUY Limit
 * (never LOC) of KRX, crypto Spot or US stocks. US rows offer it only while
 * the server lists US (Tiingo prices, 2026-10-17) or plans already exist.
 */
function takesEntryTpSl(item: RecordOrderItemDto) {
  return item.side === 'buy' && item.orderType === 'limit' && !item.limitOnClose
    && pendingAssetType(item.market) !== null;
}

type Props = {
  accountId: string;
  isFocused: boolean;
  seasonUi: boolean;
  /** Order screens: also list this account's Conditional BUY watches, SELL
   * intents (conditions; independent stop-loss/take-profit beside OCO) and
   * Futures conditional entries. */
  conditional?: boolean;
};

export default function PendingOrders(props: Props) {
  const { selectedAccountId } = useTradingAccount();
  return selectedAccountId === props.accountId ? <BoundPendingOrders key={`${props.accountId}:${getSessionGeneration()}`} {...props} /> : null;
}
const KIND_LABEL = { limit: '지정가', protection: '손절가/익절가', conditional: '조건주문' } as const;
type Kind = keyof typeof KIND_LABEL;
// Kept whole on a line: a filter too wide for its row wraps after the slash,
// never inside a word (Korean may otherwise break between any two syllables).
const glued = (label: string) => label.split('/').map(word => [...word].join(WORD_JOINER)).join(`/${ZERO_WIDTH_SPACE}`);
export function BoundPendingOrders(props: Props) {
  // No filter shows every kind; pressing the selected filter again clears it.
  const [kind, setKind] = useState<Kind | null>(null);
  // The open Futures conditional entries' own limit orders, which those
  // entries show (as a Spot conditional child stays in its list): the all
  // view lists each such order once, on its entry.
  const [entryOrderIds, setEntryOrderIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const kinds = props.conditional ? (['limit', 'protection', 'conditional'] as const) : (['limit', 'protection'] as const);
  return <View style={styles.list}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
      {kinds.map(value => <ActionPressable key={value} testID={`pending-kind-${value}`} accessibilityRole="button" accessibilityLabel={KIND_LABEL[value]} accessibilityState={{ selected: value === kind }} aria-pressed={value === kind} onPress={() => setKind(current => current === value ? null : value)} style={[styles.retry, styles.kind, value === kind && styles.kindSelected]}><Text style={styles.value}>{glued(KIND_LABEL[value])}</Text></ActionPressable>)}
    </View>
    {/* Keyed per kind: a list shown in both the all view and its own filter
        stays mounted (no re-read) when the filter changes. */}
    {(kind ? [kind] : kinds).map(value => <View key={value} style={styles.list} testID={`pending-group-${value}`}>
      {kind ? null : <Text accessibilityRole="header" style={styles.groupTitle}>{KIND_LABEL[value]}</Text>}
      {value === 'limit' ? <LimitPendingOrders {...props} excludeFuturesOrderIds={kind ? undefined : entryOrderIds} />
        : value === 'conditional' ? <>
          <ConditionalBuyOrdersList key={`conditional:${props.accountId}`} accountId={props.accountId} isFocused={props.isFocused} seasonUi={props.seasonUi} />
          <ConditionalSellOrdersList key={`sell-condition:${props.accountId}`} accountId={props.accountId} family="condition" isFocused={props.isFocused} seasonUi={props.seasonUi} />
          <FuturesConditionalEntriesList key={`futures-conditional:${props.accountId}`} accountId={props.accountId} isFocused={props.isFocused} seasonUi={props.seasonUi} onLimitOrderIds={setEntryOrderIds} />
        </>
        : <>
          {props.conditional ? <ConditionalSellOrdersList key={`sell-protection:${props.accountId}`} accountId={props.accountId} family="protection" isFocused={props.isFocused} seasonUi={props.seasonUi} /> : null}
          {props.conditional ? <FuturesTpSlList key={`futures-tp-sl:${props.accountId}`} accountId={props.accountId} isFocused={props.isFocused} /> : null}
          {props.conditional ? <EntryTpSlPlansList key={`entry-tp-sl:${props.accountId}`} accountId={props.accountId} isFocused={props.isFocused} /> : null}
          {/* Existing whole-position OCO protections (registered before 2026-10-16) and their history. */}
          <PendingFuturesAndProtections key={`protection:${props.accountId}`} accountId={props.accountId} focused={props.isFocused} seasonUi={props.seasonUi} protections />
        </>}
    </View>)}
  </View>;
}
function LimitPendingOrders({ excludeFuturesOrderIds, ...props }: Props & { excludeFuturesOrderIds?: ReadonlySet<string> }) {
  const [spotCount, setSpotCount] = useState<number | undefined>(undefined);
  const [futuresCount, setFuturesCount] = useState<number | undefined>(undefined);
  return <>
    <SpotPendingOrders {...props} onCount={setSpotCount} />
    <PendingFuturesAndProtections accountId={props.accountId} focused={props.isFocused} seasonUi={props.seasonUi} onCount={setFuturesCount} excludeOrderIds={excludeFuturesOrderIds} />
    {spotCount === 0 && futuresCount === 0 ? <InlineEmptyState title="대기 중인 지정가 주문이 없습니다." message="" /> : null}
  </>;
}

export function SpotPendingOrders({ accountId, isFocused, seasonUi, onCount }: Props & { onCount?: (count: number | undefined) => void }) {
  const queryClient = useQueryClient();
  const previous = useRef<{ accountId: string; ids: Set<string> }>({
    accountId,
    ids: new Set(),
  });
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [tpSlTarget, setTpSlTarget] = useState<TpSlTarget | null>(null);

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
  const count = !query.isError && data ? data.items.filter(item => !item.conditionalChildId).length : undefined;
  const entryRows = data?.items.filter(takesEntryTpSl) ?? [];
  const plans = useEntryTpSlSummaries(accountId, isFocused && entryRows.length > 0, (capabilities) =>
    !capabilities || entryRows.some((item) => isEntryTpSlMarketSupported(capabilities.spot, pendingAssetType(item.market))));
  useEffect(() => { onCount?.(count); }, [count, onCount]);
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
  const items = data.items.filter(item => !item.conditionalChildId);
  const sheet = <TpSlSheet target={isFocused && tpSlTarget?.accountId === accountId ? tpSlTarget : null} onClose={() => setTpSlTarget(null)} />;
  // An entry that just filled leaves the list; its open sheet stays to say so.
  if (items.length === 0) {
    return sheet;
  }

  return (
    <View style={styles.list} testID="pending-orders-list">
      <Text style={styles.count}>현물 대기 주문 {items.length}건</Text>
      {items.map((item) => {
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
              {display.orderTypeLabel} · {display.statusLabel ?? '미체결'}
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
            {(() => {
              const orderId = item.orderId ?? item.id;
              const summary = orderId ? plans.summary(orderId) : null;
              const offered = !!plans.capabilities?.spot.enabled
                && isEntryTpSlMarketSupported(plans.capabilities.spot, pendingAssetType(item.market));
              return orderId && takesEntryTpSl(item) && (offered || summary) ? (
                <TpSlButton testID={`pending-order-${display.key}-tp-sl`} summary={summary}
                  onPress={() => setTpSlTarget({ type: 'entry', accountId, entryType: 'spot_limit_order', entryId: orderId })} />
              ) : null;
            })()}
          </View>
        );
      })}
      {sheet}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10, minWidth: 0 },
  count: { fontSize: 12, color: semantic.muted },
  row: {
    backgroundColor: semantic.surface,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 14,
    gap: 6,
    minWidth: 0,
  },
  name: { fontSize: 17, fontWeight: '700', color: semantic.text, flexShrink: 1 },
  side: { fontSize: 14, fontWeight: '700' },
  buy: { color: financial.buy },
  sell: { color: financial.sell },
  metric: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: 8,
    rowGap: 2,
  },
  label: { fontSize: 13, color: semantic.muted },
  value: {
    fontSize: 14,
    color: semantic.secondary,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    maxWidth: '100%',
  },
  kind: { maxWidth: '100%' },
  kindSelected: { borderColor: semantic.selected },
  groupTitle: { fontSize: 17, lineHeight: 24, fontWeight: '800', color: semantic.text },
  retry: {
    backgroundColor: semantic.raised,
    alignSelf: 'flex-start',
    padding: 10,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 8,
  },
});
