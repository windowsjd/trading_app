import { useEffect, useState } from 'react';
import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import type { RealtimeSubscriptionEvent, RealtimeSubscriptionSpec } from '../../services/ws/realtimeSocketManager';
import { realtimeRuntimeFacts, runtimeTime, safeRuntimeCode, type RealtimeRuntimeSnapshot } from '../../services/ws/runtimeDiagnostics';
import type { AssetOrderBook } from './orderBook';
import { isOrderBookStale, ORDER_BOOK_STALE_MS, ORDER_BOOK_FIRST_SNAPSHOT_TIMEOUT_MS } from './assetOrderBookPolicy';
import { useStaleRecheck } from './useStaleRecheck';

/** Which ladder: a Spot asset's, or a USDⓈ-M contract's (keyed by instrument). */
export type OrderBookStreamSource =
  | { channel: 'asset_order_book'; id: string }
  | { channel: 'futures_order_book'; id: string };

type ConnectionState = 'connecting' | 'subscribing' | 'subscribed' | 'reconnecting' |
  'disconnected' | 'auth_failed' | 'subscription_error';
type BookState = {
  id: string;
  wsUrl: string;
  book: AssetOrderBook | null;
  receivedAt: number | null;
  subscribedAt: number | null;
  connectionState: ConnectionState;
  errorCode: string | null;
  realtime: RealtimeRuntimeSnapshot | null;
  lastAckAt: number | null;
  firstSnapshotReceivedAt: number | null;
  lastSnapshotReceivedAt: number | null;
  lastRejectionReason: string | null;
};

function initial(id: string, wsUrl: string): BookState {
  return { id, wsUrl, book: null, receivedAt: null, subscribedAt: null, connectionState: 'connecting', errorCode: null, realtime: null, lastAckAt: null,
    firstSnapshotReceivedAt: null, lastSnapshotReceivedAt: null, lastRejectionReason: null };
}

/** Reference-counted market display subscription; no query/financial cache. */
export function useOrderBookStream({ source, wsUrl, enabled = true, parse }: {
  source: OrderBookStreamSource;
  wsUrl: string;
  enabled?: boolean;
  /** Validates one data message against this exact ladder's identity. */
  parse: (payload: unknown, id: string) => AssetOrderBook | null;
}) {
  const { channel, id } = source;
  const idField = channel === 'futures_order_book' ? 'instrumentId' : 'assetId';
  const [state, setState] = useState<BookState>(() => initial(id, wsUrl));
  const [now, setNow] = useState(Date.now);
  const active = enabled && !!id && !!wsUrl;

  useEffect(() => {
    setState({ ...initial(id, wsUrl), connectionState: active ? 'connecting' : 'disconnected' });
    if (!active) return undefined;
    let mounted = true;
    const onEvent = (event: RealtimeSubscriptionEvent) => {
      if (!mounted) return;
      if (event.kind === 'runtime') {
        setState((current) => ({ ...current, realtime: event.runtime }));
        return;
      }
      if (event.kind === 'status') {
        const connectionState: ConnectionState = event.status === 'connected' ? 'subscribing' :
          event.status === 'idle' ? 'disconnected' : event.status;
        setState((current) => ({ ...current, connectionState, subscribedAt: null, errorCode: null }));
        return;
      }
      if (event.kind === 'restored') return;
      const payload = event.payload;
      const receivedAt = Date.now();
      const matchingSnapshot = payload.type === channel && payload[idField] === id;
      const book = parse(payload, id);
      if (matchingSnapshot && !book) {
        setState((current) => ({ ...current, lastSnapshotReceivedAt: receivedAt, lastRejectionReason: 'invalid_snapshot' }));
      }
      if (book) {
        setNow(receivedAt);
        setState((current) => current.book && Date.parse(current.book.capturedAt) > Date.parse(book.capturedAt)
          ? { ...current, lastSnapshotReceivedAt: receivedAt, lastRejectionReason: 'older_snapshot' }
          : { ...current, id, wsUrl, book, receivedAt, subscribedAt: null, connectionState: 'subscribed', errorCode: null,
            lastSnapshotReceivedAt: receivedAt, firstSnapshotReceivedAt: current.firstSnapshotReceivedAt ?? receivedAt });
        return;
      }
      if (payload.channel !== channel || payload[idField] !== id) return;
      if (payload.type === 'subscribed') {
        const acknowledgedAt = Date.now();
        setState((current) => ({ ...current, connectionState: 'subscribed', errorCode: null, lastAckAt: acknowledgedAt,
          // A repeated ACK must not extend the first-snapshot wait.
          subscribedAt: current.book ? null : current.subscribedAt ?? acknowledgedAt }));
      } else if (payload.type === 'subscription_error' || payload.type === 'error') {
        setState((current) => ({ ...current, connectionState: 'subscription_error', subscribedAt: null, errorCode: payload.code ?? 'INVALID_SUBSCRIPTION' }));
      }
    };
    const spec: RealtimeSubscriptionSpec = channel === 'futures_order_book'
      ? { channel, instrumentId: id }
      : { channel, assetId: id };
    const unsubscribe = getRealtimeSocketManager(wsUrl).subscribe(spec, onEvent);
    return () => { mounted = false; unsubscribe(); };
  }, [channel, idField, id, wsUrl, active, parse]);

  // Hide the previous ladder synchronously, before the effect resets state.
  const current = active && state.id === id && state.wsUrl === wsUrl ? state : initial(id, wsUrl);
  const localNow = Math.max(now, Date.now());
  const connectionState = active ? current.connectionState : 'disconnected';
  const waitingSince = connectionState === 'subscribed' && !current.book ? current.subscribedAt : null;
  const isUnavailable = waitingSince !== null && localNow - waitingSince >= ORDER_BOOK_FIRST_SNAPSHOT_TIMEOUT_MS;
  // Reuse one foreground timer; stop waiting on timeout, error, disconnect or cleanup.
  useStaleRecheck(active && (!!current.book || (waitingSince !== null && !isUnavailable)), () => setNow(Date.now()), 250);
  const isStale = isOrderBookStale(current.book, current.receivedAt, localNow);
  const statusMessage = connectionState === 'auth_failed' ? '로그인 상태를 확인해주세요.' :
    connectionState === 'subscription_error' ? '호가 정보를 구독할 수 없습니다.' :
    connectionState === 'reconnecting' || connectionState === 'disconnected' ? '호가 연결을 복구하는 중입니다.' :
    isUnavailable ? '호가 정보를 현재 수신할 수 없습니다.' :
    isStale ? '호가 정보가 지연되고 있습니다.' :
    !current.book ? '호가 정보를 불러오는 중입니다.' : null;

  const unavailableReason = connectionState === 'auth_failed' ? 'auth_failed' :
    connectionState === 'subscription_error' ? 'subscription_error' :
    connectionState === 'reconnecting' || connectionState === 'disconnected' ? `socket_${connectionState}` :
    isUnavailable ? 'first_snapshot_timeout' : !current.book ?
      current.subscribedAt !== null ? 'awaiting_first_snapshot' : 'awaiting_subscription_ack' : null;
  return { latestOrderBook: current.book, connectionState, isStale, isUnavailable, errorCode: current.errorCode, statusMessage,
    runtime: {
      ...realtimeRuntimeFacts(current.realtime), [idField]: id, channel, connectionState,
      lastAckReceivedAt: runtimeTime(current.lastAckAt), subscribedAt: runtimeTime(current.subscribedAt),
      firstSnapshotReceivedAt: runtimeTime(current.firstSnapshotReceivedAt),
      lastSnapshotReceivedAt: runtimeTime(current.lastSnapshotReceivedAt),
      lastSnapshotAcceptedAt: runtimeTime(current.receivedAt), lastBookCapturedAt: current.book?.capturedAt,
      lastRejectionReason: current.lastRejectionReason,
      subscriptionErrorCode: current.realtime?.subscription.lastSubscriptionErrorCode ??
        (current.errorCode ? safeRuntimeCode(current.errorCode) ?? 'not_observed' : null), firstSnapshotTimeoutMs: ORDER_BOOK_FIRST_SNAPSHOT_TIMEOUT_MS,
      firstSnapshotTimedOut: isUnavailable, staleThresholdMs: ORDER_BOOK_STALE_MS,
      freshnessBasis: 'client_receipt', isStale, staleReason: isStale ? 'freshness_timeout' : null, unavailableReason,
    },
  };
}
