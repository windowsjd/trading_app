import { useEffect, useRef, useState } from 'react';

import { getAccessToken } from '../../services/storage/tokenStorage';

interface UseAssetTickerParams {
  assetId: string;
  wsUrl: string;
  enabled?: boolean;
}

export type AssetTickerConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failed'
  | 'subscription_error';

export interface AssetTickerMessage {
  type: 'asset_ticker';
  assetId: string;
  symbol?: string;
  name?: string;
  priceLocal: string;
  priceCurrency?: 'KRW' | 'USD';
  priceKrw: string;
  priceKrwState?: string;
  changeRate: string;
  assetPriceSnapshotId?: string | null;
  priceCapturedAt?: string | null;
  priceEffectiveAt?: string | null;
  capturedAt?: string | null;
  freshnessAgeSeconds?: number | null;
}

type AssetTickerControlMessage = {
  type?: string;
  code?: string;
  message?: string;
};

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const STALE_FRESHNESS_THRESHOLD_SECONDS = 60;

function appendToken(wsUrl: string, token: string | null) {
  if (!token) return wsUrl;

  const separator = wsUrl.includes('?') ? '&' : '?';
  return `${wsUrl}${separator}token=${encodeURIComponent(token)}`;
}

function parseTimestamp(value?: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getTickerTimestamp(payload: AssetTickerMessage) {
  return parseTimestamp(payload.priceCapturedAt ?? payload.capturedAt) ??
    parseTimestamp(payload.priceEffectiveAt);
}

function isTickerStale(payload: AssetTickerMessage | null) {
  const freshnessAgeSeconds = payload?.freshnessAgeSeconds;
  if (typeof freshnessAgeSeconds !== 'number') return false;

  // Server-driven freshness metadata is not yet exposed as a threshold.
  return freshnessAgeSeconds > STALE_FRESHNESS_THRESHOLD_SECONDS;
}

export function useAssetTicker({
  assetId,
  wsUrl,
  enabled = true,
}: UseAssetTickerParams) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const latestTickerRef = useRef<AssetTickerMessage | null>(null);
  const latestSnapshotIdRef = useRef<string | null>(null);
  const latestTimestampRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(false);

  const [latestTicker, setLatestTicker] = useState<AssetTickerMessage | null>(null);
  const [connectionState, setConnectionState] =
    useState<AssetTickerConnectionState>('disconnected');
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    if (!enabled || !assetId || !wsUrl) {
      setConnectionState('disconnected');
      setShowReconnectBanner(false);
      return undefined;
    }

    let isMounted = true;
    shouldReconnectRef.current = true;

    const clearReconnectTimeout = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const sendSubscription = (ws: WebSocket, type: 'subscribe' | 'unsubscribe') => {
      try {
        ws.send(
          JSON.stringify({
            type,
            channel: 'asset_ticker',
            assetId,
          }),
        );
      } catch {
        // Ignore best-effort unsubscribe/subscription send failures.
      }
    };

    const acceptTicker = (payload: AssetTickerMessage) => {
      if (payload.assetId !== assetId) return;

      const snapshotId = payload.assetPriceSnapshotId ?? null;
      if (snapshotId && snapshotId === latestSnapshotIdRef.current) return;

      const nextTimestamp = getTickerTimestamp(payload);
      const currentTimestamp = latestTimestampRef.current;
      if (nextTimestamp === null && latestTickerRef.current) return;
      if (
        nextTimestamp !== null &&
        currentTimestamp !== null &&
        nextTimestamp < currentTimestamp
      ) {
        return;
      }

      latestTickerRef.current = payload;
      latestSnapshotIdRef.current = snapshotId;
      latestTimestampRef.current = nextTimestamp;
      setLatestTicker(payload);
      setIsStale(isTickerStale(payload));
    };

    const scheduleReconnect = () => {
      if (!isMounted || !shouldReconnectRef.current) return;

      setConnectionState((current) =>
        current === 'auth_failed' || current === 'subscription_error'
          ? current
          : 'reconnecting',
      );
      setShowReconnectBanner(true);

      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS_MS.length - 1)
        ];
      reconnectAttemptRef.current += 1;

      clearReconnectTimeout();
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    const connect = async () => {
      clearReconnectTimeout();
      if (!isMounted || !shouldReconnectRef.current) return;

      setConnectionState(
        reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting',
      );

      const token = await getAccessToken();
      if (!isMounted || !shouldReconnectRef.current) return;

      const ws = new WebSocket(appendToken(wsUrl, token));
      socketRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;

        reconnectAttemptRef.current = 0;
        setConnectionState('connected');
        setShowReconnectBanner(false);
        sendSubscription(ws, 'subscribe');
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;

        try {
          const payload = JSON.parse(event.data) as
            | AssetTickerMessage
            | AssetTickerControlMessage;

          if (payload.type === 'asset_ticker') {
            acceptTicker(payload as AssetTickerMessage);
            return;
          }

          if (payload.type === 'auth_failed') {
            shouldReconnectRef.current = false;
            setConnectionState('auth_failed');
            setShowReconnectBanner(true);
            ws.close();
            return;
          }

          if (payload.type === 'subscription_error') {
            setConnectionState('subscription_error');
            setShowReconnectBanner(true);
          }
        } catch {
          // Ignore malformed messages.
        }
      };

      ws.onerror = () => {
        if (!isMounted) return;
        setShowReconnectBanner(true);
      };

      ws.onclose = (event) => {
        if (!isMounted) return;

        if (event.code === 1008) {
          shouldReconnectRef.current = false;
          setConnectionState('auth_failed');
          setShowReconnectBanner(true);
          return;
        }

        setConnectionState('disconnected');
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      isMounted = false;
      shouldReconnectRef.current = false;
      clearReconnectTimeout();

      const ws = socketRef.current;
      if (ws) {
        sendSubscription(ws, 'unsubscribe');
        ws.close();
      }
      socketRef.current = null;
    };
  }, [assetId, wsUrl, enabled]);

  return {
    connectionState,
    latestTicker,
    showReconnectBanner,
    isStale,
  };
}
