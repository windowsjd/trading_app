import { useEffect, useState } from 'react';
import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager';
import type { AssetOrderBook } from './orderBook';
import { isOrderBookStale, parseAssetOrderBook } from './assetOrderBookPolicy';
import { useStaleRecheck } from './useStaleRecheck';

type ConnectionState = 'connecting' | 'subscribing' | 'subscribed' | 'reconnecting' |
  'disconnected' | 'auth_failed' | 'subscription_error';
type BookState = {
  assetId: string;
  wsUrl: string;
  book: AssetOrderBook | null;
  receivedAt: number | null;
  connectionState: ConnectionState;
  errorCode: string | null;
};

function initial(assetId: string, wsUrl: string): BookState {
  return { assetId, wsUrl, book: null, receivedAt: null, connectionState: 'connecting', errorCode: null };
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
        setState((current) => ({ ...current, connectionState, errorCode: null }));
        return;
      }
      if (event.kind === 'restored') return;
      const payload = event.payload;
      const book = parseAssetOrderBook(payload, assetId);
      if (book) {
        const receivedAt = Date.now();
        setNow(receivedAt);
        setState((current) => current.book && Date.parse(current.book.capturedAt) > Date.parse(book.capturedAt)
          ? current : { assetId, wsUrl, book, receivedAt, connectionState: 'subscribed', errorCode: null });
        return;
      }
      if (payload.channel !== 'asset_order_book' || payload.assetId !== assetId) return;
      if (payload.type === 'subscribed') {
        setState((current) => ({ ...current, connectionState: 'subscribed', errorCode: null }));
      } else if (payload.type === 'subscription_error' || payload.type === 'error') {
        setState((current) => ({ ...current, connectionState: 'subscription_error', errorCode: payload.code ?? 'INVALID_SUBSCRIPTION' }));
      }
    };
    const unsubscribe = getRealtimeSocketManager(wsUrl).subscribe({ channel: 'asset_order_book', assetId }, onEvent);
    return () => { mounted = false; unsubscribe(); };
  }, [assetId, wsUrl, active]);

  // Hide the previous asset synchronously, before the effect resets state.
  const current = active && state.assetId === assetId && state.wsUrl === wsUrl ? state : initial(assetId, wsUrl);
  useStaleRecheck(active && !!current.book, () => setNow(Date.now()), 250);
  const isStale = isOrderBookStale(current.book, current.receivedAt, Math.max(now, Date.now()));
  const connectionState = active ? current.connectionState : 'disconnected';
  const statusMessage = connectionState === 'auth_failed' ? '로그인 상태를 확인해주세요.' :
    connectionState === 'subscription_error' ? '호가 정보를 구독할 수 없습니다.' :
    connectionState === 'reconnecting' || connectionState === 'disconnected' ? '호가 연결을 복구하는 중입니다.' :
    isStale ? '호가 정보가 지연되고 있습니다.' :
    !current.book ? '호가 정보를 불러오는 중입니다.' : null;

  return { latestOrderBook: current.book, connectionState, isStale, errorCode: current.errorCode, statusMessage };
}
