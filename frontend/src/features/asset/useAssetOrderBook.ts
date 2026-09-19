import { useEffect, useState } from 'react';
import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager';
import type { AssetOrderBook } from './orderBook';
import { isOrderBookStale, ORDER_BOOK_FIRST_SNAPSHOT_TIMEOUT_MS, parseAssetOrderBook } from './assetOrderBookPolicy';
import { useStaleRecheck } from './useStaleRecheck';

type ConnectionState = 'connecting' | 'subscribing' | 'subscribed' | 'reconnecting' |
  'disconnected' | 'auth_failed' | 'subscription_error';
type BookState = {
  assetId: string;
  wsUrl: string;
  book: AssetOrderBook | null;
  receivedAt: number | null;
  subscribedAt: number | null;
  connectionState: ConnectionState;
  errorCode: string | null;
};

function initial(assetId: string, wsUrl: string): BookState {
  return { assetId, wsUrl, book: null, receivedAt: null, subscribedAt: null, connectionState: 'connecting', errorCode: null };
}

/** Reference-counted market display subscription; no query/financial cache. */
export function useAssetOrderBook({ assetId, wsUrl, enabled = true }: {
  assetId: string; wsUrl: string; enabled?: boolean;
}) {
  const [state, setState] = useState<BookState>(() => initial(assetId, wsUrl));
  const [now, setNow] = useState(Date.now);
  const active = enabled && !!assetId && !!wsUrl;

  useEffect(() => {
    setState({ ...initial(assetId, wsUrl), connectionState: active ? 'connecting' : 'disconnected' });
    if (!active) return undefined;
    let mounted = true;
    const onEvent = (event: RealtimeSubscriptionEvent) => {
      if (!mounted) return;
      if (event.kind === 'status') {
        const connectionState: ConnectionState = event.status === 'connected' ? 'subscribing' :
          event.status === 'idle' ? 'disconnected' : event.status;
        setState((current) => ({ ...current, connectionState, subscribedAt: null, errorCode: null }));
        return;
      }
      if (event.kind === 'restored') return;
      const payload = event.payload;
      const book = parseAssetOrderBook(payload, assetId);
      if (book) {
        const receivedAt = Date.now();
        setNow(receivedAt);
        setState((current) => current.book && Date.parse(current.book.capturedAt) > Date.parse(book.capturedAt)
          ? current : { assetId, wsUrl, book, receivedAt, subscribedAt: null, connectionState: 'subscribed', errorCode: null });
        return;
      }
      if (payload.channel !== 'asset_order_book' || payload.assetId !== assetId) return;
      if (payload.type === 'subscribed') {
        const acknowledgedAt = Date.now();
        setState((current) => ({ ...current, connectionState: 'subscribed', errorCode: null,
          // A repeated ACK must not extend the first-snapshot wait.
          subscribedAt: current.book ? null : current.subscribedAt ?? acknowledgedAt }));
      } else if (payload.type === 'subscription_error' || payload.type === 'error') {
        setState((current) => ({ ...current, connectionState: 'subscription_error', subscribedAt: null, errorCode: payload.code ?? 'INVALID_SUBSCRIPTION' }));
      }
    };
    const unsubscribe = getRealtimeSocketManager(wsUrl).subscribe({ channel: 'asset_order_book', assetId }, onEvent);
    return () => { mounted = false; unsubscribe(); };
  }, [assetId, wsUrl, active]);

  // Hide the previous asset synchronously, before the effect resets state.
  const current = active && state.assetId === assetId && state.wsUrl === wsUrl ? state : initial(assetId, wsUrl);
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

  return { latestOrderBook: current.book, connectionState, isStale, isUnavailable, errorCode: current.errorCode, statusMessage };
}
