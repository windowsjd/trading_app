import { useEffect, useRef, useState } from 'react';

import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager';

interface UseAssetTickerParams {
  assetId: string;
  wsUrl: string;
  enabled?: boolean;
}

export type AssetTickerConnectionState =
  | 'connecting'
  | 'connected'
  | 'subscribing'
  | 'subscribed'
  | 'unsubscribed'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failed'
  | 'subscription_error';

export interface AssetTickerMessage {
  type: 'asset_ticker';
  assetId: string;
  symbol?: string;
  name?: string;
  priceLocal: string | null;
  priceCurrency?: 'KRW' | 'USD';
  priceKrw: string | null;
  priceKrwState?: string;
  changeRate?: string | null;
  assetPriceSnapshotId?: string | null;
  priceCapturedAt?: string | null;
  priceEffectiveAt?: string | null;
  capturedAt?: string | null;
  freshnessAgeSeconds?: number | null;
  reason?: string;
  message?: string;
}

type AssetTickerControlMessage = {
  type?: string;
  channel?: string;
  assetId?: string;
  code?: string;
  message?: string;
};

const STALE_FRESHNESS_THRESHOLD_SECONDS = 60;

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

function isCurrentAssetTickerControlMessage(
  payload: AssetTickerControlMessage,
  assetId: string,
) {
  return payload.channel === 'asset_ticker' && payload.assetId === assetId;
}

function isRelevantAssetTickerError(
  payload: AssetTickerControlMessage,
  assetId: string,
) {
  if (payload.channel && payload.channel !== 'asset_ticker') return false;
  if (payload.assetId && payload.assetId !== assetId) return false;
  return true;
}

function isUnavailableTicker(payload: AssetTickerMessage) {
  return !!payload.priceKrwState && payload.priceKrwState !== 'available';
}

/**
 * Subscribes to the asset_ticker channel on the app-wide shared WebSocket.
 * The socket itself is owned by RealtimeSocketManager and is shared with
 * every other realtime hook (e.g. useAssetCandle); unmounting only releases
 * this hook's subscription.
 */
export function useAssetTicker({
  assetId,
  wsUrl,
  enabled = true,
}: UseAssetTickerParams) {
  const latestTickerRef = useRef<AssetTickerMessage | null>(null);
  const latestSnapshotIdRef = useRef<string | null>(null);
  const latestTimestampRef = useRef<number | null>(null);

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

    const acceptTicker = (payload: AssetTickerMessage) => {
      if (payload.assetId !== assetId) return;

      const snapshotId = payload.assetPriceSnapshotId ?? null;
      if (snapshotId && snapshotId === latestSnapshotIdRef.current) return;

      const nextTimestamp = getTickerTimestamp(payload);
      const currentTimestamp = latestTimestampRef.current;
      if (
        nextTimestamp === null &&
        latestTickerRef.current &&
        !isUnavailableTicker(payload)
      ) {
        return;
      }
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

    const onEvent = (event: RealtimeSubscriptionEvent) => {
      if (!isMounted) return;

      if (event.kind === 'status') {
        switch (event.status) {
          case 'connecting':
            setConnectionState('connecting');
            return;
          case 'connected':
            setConnectionState('subscribing');
            setShowReconnectBanner(false);
            return;
          case 'reconnecting':
            setConnectionState((current) =>
              current === 'auth_failed' || current === 'subscription_error'
                ? current
                : 'reconnecting',
            );
            setShowReconnectBanner(true);
            return;
          case 'disconnected':
            setConnectionState('disconnected');
            setShowReconnectBanner(true);
            return;
          case 'auth_failed':
            setConnectionState('auth_failed');
            setShowReconnectBanner(true);
            return;
          default:
            return;
        }
      }
      if (event.kind === 'restored') return;

      const payload = event.payload as
        | AssetTickerMessage
        | AssetTickerControlMessage;

      if (payload.type === 'asset_ticker') {
        acceptTicker(payload as AssetTickerMessage);
        return;
      }

      if (payload.type === 'error') {
        if (
          (payload as AssetTickerControlMessage).code === 'INVALID_SUBSCRIPTION' ||
          isRelevantAssetTickerError(payload as AssetTickerControlMessage, assetId)
        ) {
          if (!isRelevantAssetTickerError(payload as AssetTickerControlMessage, assetId)) return;
          setConnectionState('subscription_error');
          setShowReconnectBanner(true);
          return;
        }
      }

      if (payload.type === 'subscription_error') {
        if (!isCurrentAssetTickerControlMessage(payload as AssetTickerControlMessage, assetId)) return;
        setConnectionState('subscription_error');
        setShowReconnectBanner(true);
        return;
      }

      if (payload.type === 'subscribed') {
        if (!isCurrentAssetTickerControlMessage(payload as AssetTickerControlMessage, assetId)) return;
        setConnectionState('subscribed');
        setShowReconnectBanner(false);
        return;
      }

      if (payload.type === 'unsubscribed') {
        if (!isCurrentAssetTickerControlMessage(payload as AssetTickerControlMessage, assetId)) return;
        setConnectionState('unsubscribed');
        setShowReconnectBanner(false);
      }
    };

    const manager = getRealtimeSocketManager(wsUrl);
    const unsubscribe = manager.subscribe(
      { channel: 'asset_ticker', assetId },
      onEvent,
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [assetId, wsUrl, enabled]);

  return {
    connectionState,
    latestTicker,
    showReconnectBanner,
    isStale,
  };
}
