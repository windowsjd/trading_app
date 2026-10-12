import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useTradingAccount } from '../tradingAccount/TradingAccountContext';
import { getAccountDisplay } from '../tradingAccount/accountDisplay';
import {
  getTradingAccountOrder,
  getTradingAccountOrders,
  type TradingAccountDto,
} from '../tradingAccount/api';
import { getAccountPendingOrders } from '../record/accountOrders';
import { getConditionalBuyOrder, getConditionalBuyOrders } from '../conditional/conditionalBuyApi';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { rootNavigationRef } from '../../app/navigation/navigationRef';
import {
  buildFillNotice,
  createFillTracker,
  enqueueFillNotice,
  isFillWatchAccount,
  type FilledOrderFacts,
  type FillNotice,
  type FillOrigin,
  type FillTracker,
} from './fillTracker';
import { subscribeOrderFillEvents } from './fillEvents';
import OrderFillBanner from './OrderFillBanner';

/**
 * While something can still fill, the open sets are re-read at this pace in
 * the foreground only. The order screen's own lists poll faster and share the
 * same cache entries, so they speed detection up for free.
 */
export const FILL_POLL_MS = 15_000;

/**
 * App-wide real-fill banner. Mounted once beside the root navigator so a fill
 * shows on every tab and pushed screen. One session = one tracker: a logout or
 * user change (session generation) remounts everything, dropping the previous
 * user's queue, watchers and pending reads.
 */
export default function OrderFillNotifier() {
  const { accounts } = useTradingAccount();
  const generation = getSessionGeneration();
  const watched = useMemo(() => accounts.filter(isFillWatchAccount), [accounts]);
  return <FillSession key={generation} generation={generation} accounts={watched} />;
}

function useAppActive() {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setState);
    return () => subscription.remove();
  }, []);
  // Web and an unknown initial state count as foreground.
  return state === 'active' || state == null || state === 'unknown';
}

function FillSession({ generation, accounts }: { generation: number; accounts: TradingAccountDto[] }) {
  const tracker = useRef<FillTracker>(createFillTracker()).current;
  const [queue, setQueue] = useState<FillNotice[]>([]);
  // Tracker changes re-render the watchers so their polls switch on/off.
  const [, setRevision] = useState(0);
  const active = useAppActive();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const current = useCallback(() => alive.current && isCurrentSession(generation), [generation]);
  const touched = useCallback(() => setRevision((value) => value + 1), []);
  const labels = useMemo(() => new Map(accounts.map((account) => [account.id, accounts.length > 1 ? getAccountDisplay(account).title : null])), [accounts]);
  const watchedIds = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts]);

  const announce = useCallback((accountId: string, order: FilledOrderFacts, origin: FillOrigin) => {
    const notice = buildFillNotice(accountId, order, { origin, accountLabel: labels.get(accountId) ?? null });
    if (!notice || !current() || !tracker.settle(accountId, notice.orderId)) return;
    setQueue((previous) => enqueueFillNotice(previous, notice));
  }, [current, labels, tracker]);

  /** One order left an open set: announce it only if its detail is an execution. */
  const resolveOrder = useCallback(async (accountId: string, orderId: string, origin?: FillOrigin) => {
    try {
      const detail = await getTradingAccountOrder(accountId, orderId);
      if (!current()) return;
      const order = detail.order as FilledOrderFacts;
      const effectiveOrigin = origin ?? tracker.originOf(accountId, orderId);
      if (order.status === 'submitted') tracker.trackOrder(accountId, orderId, effectiveOrigin);
      else if (order.status === 'executed') announce(accountId, { ...order, orderId }, effectiveOrigin);
      // canceled / rejected (incl. LOC unfilled or expired): nothing to announce.
    } catch {
      if (current() && tracker.retry(accountId, orderId)) tracker.trackOrder(accountId, orderId, origin ?? tracker.originOf(accountId, orderId));
    } finally {
      if (current()) touched();
    }
  }, [announce, current, touched, tracker]);

  /** A watch left the live list: follow its linked order, never the trigger. */
  const resolveWatch = useCallback(async (accountId: string, watchId: string) => {
    try {
      const { conditionalOrder: row } = await getConditionalBuyOrder(accountId, watchId);
      if (!current()) return;
      if (row.state === 'watching' || row.state === 'triggered') tracker.trackWatch(accountId, watchId);
      else if (row.state === 'order_pending' && row.order?.orderId) tracker.trackOrder(accountId, row.order.orderId, 'conditional');
      else if (row.state === 'filled' && row.order?.orderId) await resolveOrder(accountId, row.order.orderId, 'conditional');
    } catch {
      if (current() && tracker.retry(accountId, `watch:${watchId}`)) tracker.trackWatch(accountId, watchId);
    } finally {
      if (current()) touched();
    }
  }, [current, resolveOrder, touched, tracker]);

  useEffect(() => subscribeOrderFillEvents((event) => {
    if (!current() || !watchedIds.has(event.accountId)) return;
    if (event.kind === 'order') tracker.trackOrder(event.accountId, event.orderId, event.origin);
    else if (event.kind === 'watch') tracker.trackWatch(event.accountId, event.watchId);
    else announce(event.accountId, event.order, 'order');
    touched();
  }), [announce, current, touched, tracker, watchedIds]);

  const head = queue[0] ?? null;
  return (
    <>
      {accounts.map((account) => (
        <AccountFillWatcher key={account.id} accountId={account.id} active={active} tracker={tracker}
          onOrderGone={resolveOrder} onWatchGone={resolveWatch} touched={touched} />
      ))}
      <OrderFillBanner
        notice={head}
        onDone={() => setQueue((previous) => previous.slice(1))}
        onOpenHistory={(notice) => {
          // The order's own account, never whatever is selected now.
          if (rootNavigationRef.isReady()) rootNavigationRef.navigate('TradeHistory', { accountId: notice.accountId });
        }}
      />
    </>
  );
}

function AccountFillWatcher({ accountId, active, tracker, onOrderGone, onWatchGone, touched }: {
  accountId: string;
  active: boolean;
  tracker: FillTracker;
  onOrderGone: (accountId: string, orderId: string) => Promise<void>;
  onWatchGone: (accountId: string, watchId: string) => Promise<void>;
  touched: () => void;
}) {
  const openOrders = tracker.hasOpenOrders(accountId);
  const openWatches = tracker.hasOpenWatches(accountId);
  // Same key and read as the order screen's pending list: one cache entry,
  // every page of submitted orders, account envelope checked per page.
  const pending = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.pendingOrders(accountId),
    queryFn: () => getAccountPendingOrders(accountId, getTradingAccountOrders),
    enabled: active,
    refetchInterval: active && openOrders ? FILL_POLL_MS : false,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  // Default list = live watches only (watching/triggered); ≤ 20 per account.
  const watches = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.list(accountId, { history: false, limit: 100 }),
    queryFn: ({ signal }) => getConditionalBuyOrders(accountId, { limit: 100 }, signal),
    enabled: active,
    // With the server flag off nothing triggers, so there is nothing to wait for.
    refetchInterval: (query) => active && openWatches && query.state.data?.capabilities.enabled === true ? FILL_POLL_MS : false,
    refetchIntervalInBackground: false,
    retry: 1,
  });

  const pendingSeen = useRef(0);
  useEffect(() => {
    const data = pending.data;
    if (!data || data.tradingAccountId !== accountId || pending.dataUpdatedAt === pendingSeen.current) return;
    pendingSeen.current = pending.dataUpdatedAt;
    const gone = tracker.observePending(accountId, data.items.map((item) => item.orderId ?? item.id).filter((id): id is string => !!id));
    gone.forEach((orderId) => void onOrderGone(accountId, orderId));
    touched();
  }, [accountId, onOrderGone, pending.data, pending.dataUpdatedAt, touched, tracker]);

  const watchesSeen = useRef(0);
  useEffect(() => {
    const data = watches.data;
    if (!data || data.tradingAccountId !== accountId || watches.dataUpdatedAt === watchesSeen.current) return;
    if (data.pagination.nextOffset !== null) return; // incomplete set: never diff it
    watchesSeen.current = watches.dataUpdatedAt;
    const gone = tracker.observeWatches(accountId, data.conditionalOrders.map((row) => row.id));
    gone.forEach((watchId) => void onWatchGone(accountId, watchId));
    touched();
  }, [accountId, onWatchGone, touched, tracker, watches.data, watches.dataUpdatedAt]);
  return null;
}
