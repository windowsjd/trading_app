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
import { getConditionalSellOrder, getConditionalSellOrders } from '../conditional/conditionalSellApi';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { getApiErrorInfo } from '../../services/api/errorMapper';
import { rootNavigationRef } from '../../app/navigation/navigationRef';
import { questNavigationAllowed } from '../quest/questNavigationGuard';
import {
  buildFillNotice,
  buildLiquidationNotice,
  createFillTracker,
  enqueueFillNotice,
  isFillWatchAccount,
  isTransientFillReadFailure,
  type FilledOrderFacts,
  type FillNotice,
  type FillOrigin,
  type FillTarget,
  type FillTracker,
} from './fillTracker';
import { subscribeOrderFillEvents } from './fillEvents';
import OrderFillBanner, { type FillHistoryOutcome } from './OrderFillBanner';

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

  /** A failed read is unknown, never a cancel: keep the target for a later check. */
  const failed = useCallback((accountId: string, target: FillTarget, cause: unknown) => {
    if (!current()) return;
    if (isTransientFillReadFailure(getApiErrorInfo(cause))) tracker.defer(accountId, target, Date.now());
    else tracker.resolved(accountId, target.kind, target.id);
  }, [current, tracker]);

  /** One order left an open set: announce it only if its detail is an execution. */
  const resolveOrder = useCallback(async (accountId: string, orderId: string, origin?: FillOrigin) => {
    if (!tracker.beginRead(accountId, 'order', orderId)) return;
    const effectiveOrigin = origin ?? tracker.originOf(accountId, orderId);
    try {
      const detail = await getTradingAccountOrder(accountId, orderId);
      if (!current()) return;
      tracker.resolved(accountId, 'order', orderId);
      const order = detail.order as FilledOrderFacts;
      if (order.status === 'submitted') tracker.trackOrder(accountId, orderId, effectiveOrigin);
      else if (order.status === 'executed') announce(accountId, { ...order, orderId }, effectiveOrigin);
      // canceled / rejected (incl. LOC unfilled or expired): nothing to announce.
      else tracker.forgetOrder(accountId, orderId);
    } catch (cause) {
      failed(accountId, { kind: 'order', id: orderId, origin: effectiveOrigin }, cause);
    } finally {
      tracker.endRead(accountId, 'order', orderId);
      if (current()) touched();
    }
  }, [announce, current, failed, touched, tracker]);

  /** A watch left the live list: follow its linked order, never the trigger. */
  const resolveWatch = useCallback(async (accountId: string, watchId: string) => {
    if (!tracker.beginRead(accountId, 'watch', watchId)) return;
    try {
      const { conditionalOrder: row } = await getConditionalBuyOrder(accountId, watchId);
      if (!current()) return;
      tracker.resolved(accountId, 'watch', watchId);
      if (row.state === 'watching' || row.state === 'triggered') tracker.trackWatch(accountId, watchId);
      else if (row.state === 'order_pending' && row.order?.orderId) tracker.trackOrder(accountId, row.order.orderId, 'conditional');
      else if (row.state === 'filled' && row.order?.orderId) await resolveOrder(accountId, row.order.orderId, 'conditional');
    } catch (cause) {
      failed(accountId, { kind: 'watch', id: watchId, origin: 'conditional' }, cause);
    } finally {
      tracker.endRead(accountId, 'watch', watchId);
      if (current()) touched();
    }
  }, [current, failed, resolveOrder, touched, tracker]);

  /** A SELL intent left the live list: follow its linked order, never the trigger. */
  const resolveSellWatch = useCallback(async (accountId: string, watchId: string) => {
    if (!tracker.beginRead(accountId, 'sell_watch', watchId)) return;
    try {
      const { conditionalOrder: row } = await getConditionalSellOrder(accountId, watchId);
      if (!current()) return;
      tracker.resolved(accountId, 'sell_watch', watchId);
      const origin: FillOrigin = row.kind === 'condition' ? 'conditional' : row.kind;
      if (row.state === 'watching' || row.state === 'triggered') tracker.trackSellWatch(accountId, watchId);
      else if (row.state === 'order_pending' && row.order?.orderId) tracker.trackOrder(accountId, row.order.orderId, origin);
      else if (row.state === 'filled' && row.order?.orderId) await resolveOrder(accountId, row.order.orderId, origin);
      // failed / canceled (incl. nothing left to sell): no fill to announce.
    } catch (cause) {
      failed(accountId, { kind: 'sell_watch', id: watchId, origin: 'conditional' }, cause);
    } finally {
      tracker.endRead(accountId, 'sell_watch', watchId);
      if (current()) touched();
    }
  }, [current, failed, resolveOrder, touched, tracker]);

  /** Re-read the targets whose backoff ran out (foreground only). */
  const retryDue = useCallback((accountId: string) => {
    if (!current()) return;
    for (const target of tracker.due(accountId, Date.now())) {
      if (target.kind === 'order') void resolveOrder(accountId, target.id, target.origin);
      else if (target.kind === 'sell_watch') void resolveSellWatch(accountId, target.id);
      else void resolveWatch(accountId, target.id);
    }
    touched();
  }, [current, resolveOrder, resolveSellWatch, resolveWatch, touched, tracker]);

  // Back from the background: check every unresolved target once now.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      tracker.wake(Date.now());
      touched();
    }
    wasActive.current = active;
  }, [active, touched, tracker]);

  useEffect(() => subscribeOrderFillEvents((event) => {
    if (!current() || !watchedIds.has(event.accountId)) return;
    if (event.kind === 'order') tracker.trackOrder(event.accountId, event.orderId, event.origin);
    else if (event.kind === 'watch' && event.side === 'sell') tracker.trackSellWatch(event.accountId, event.watchId);
    else if (event.kind === 'watch') tracker.trackWatch(event.accountId, event.watchId);
    else if (event.kind === 'liquidation') {
      // Same queue as fills: one banner at a time, never stacked; the
      // settled set keeps a re-delivered push from showing again.
      const notice = buildLiquidationNotice(event);
      if (tracker.settle(event.accountId, notice.orderId)) setQueue((previous) => enqueueFillNotice(previous, notice));
    } else announce(event.accountId, event.order, 'order');
    touched();
  }), [announce, current, touched, tracker, watchedIds]);

  const head = queue[0] ?? null;
  return (
    <>
      {accounts.map((account) => (
        <AccountFillWatcher key={account.id} accountId={account.id} active={active} tracker={tracker}
          onOrderGone={resolveOrder} onWatchGone={resolveWatch} onSellWatchGone={resolveSellWatch}
          onRetryDue={retryDue} touched={touched} />
      ))}
      <OrderFillBanner
        notice={head}
        onDone={() => setQueue((previous) => previous.slice(1))}
        onOpenHistory={openHistory}
      />
    </>
  );
}

/**
 * 내역 보기: the order's own account, never whatever is selected now. An
 * active beginner guide holds the move exactly as its root router would (the
 * guide then shows its 안내 종료 notice); the banner says so instead of
 * leaving as if the history had opened.
 */
function openHistory(notice: FillNotice): FillHistoryOutcome {
  if (!rootNavigationRef.isReady()) return 'unavailable';
  if (!questNavigationAllowed('TradeHistory')) return 'held';
  // A view target carries a per-press stamp so an open history selects it again.
  rootNavigationRef.navigate('TradeHistory', {
    accountId: notice.accountId,
    ...(notice.history ? { ...notice.history, pushAt: Date.now() } : {}),
  });
  return 'opened';
}

function AccountFillWatcher({ accountId, active, tracker, onOrderGone, onWatchGone, onSellWatchGone, onRetryDue, touched }: {
  accountId: string;
  active: boolean;
  tracker: FillTracker;
  onOrderGone: (accountId: string, orderId: string) => Promise<void>;
  onWatchGone: (accountId: string, watchId: string) => Promise<void>;
  onSellWatchGone: (accountId: string, watchId: string) => Promise<void>;
  onRetryDue: (accountId: string) => void;
  touched: () => void;
}) {
  const openOrders = tracker.hasOpenOrders(accountId);
  const openWatches = tracker.hasOpenWatches(accountId);
  const openSellWatches = tracker.hasOpenSellWatches(accountId);
  // Unresolved reads wait for their backoff; nothing runs in the background.
  const retryAt = tracker.nextRetryAt(accountId);
  useEffect(() => {
    if (!active || retryAt === null) return;
    const timer = setTimeout(() => onRetryDue(accountId), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [accountId, active, onRetryDue, retryAt]);
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

  // Live SELL intents (watching/triggered); same key as the sell order form's gate.
  const sellWatches = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalSell.list(accountId, { history: false, limit: 100 }),
    queryFn: ({ signal }) => getConditionalSellOrders(accountId, { limit: 100 }, signal),
    enabled: active,
    // With both SELL flags off nothing triggers, so there is nothing to wait for.
    refetchInterval: (query) => active && openSellWatches && query.state.data?.capabilities.enabled === true ? FILL_POLL_MS : false,
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

  const sellWatchesSeen = useRef(0);
  useEffect(() => {
    const data = sellWatches.data;
    if (!data || data.tradingAccountId !== accountId || sellWatches.dataUpdatedAt === sellWatchesSeen.current) return;
    if (data.pagination.nextOffset !== null) return; // incomplete set: never diff it
    sellWatchesSeen.current = sellWatches.dataUpdatedAt;
    const gone = tracker.observeSellWatches(accountId, data.conditionalOrders.map((row) => row.id));
    gone.forEach((watchId) => void onSellWatchGone(accountId, watchId));
    touched();
  }, [accountId, onSellWatchGone, sellWatches.data, sellWatches.dataUpdatedAt, touched, tracker]);
  return null;
}
