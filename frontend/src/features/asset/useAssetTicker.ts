import { useEffect, useRef, useState } from 'react';

import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager';
import {
  applyTicker,
  isTickerStaleAt,
  type AssetTickerAcceptState,
  type AssetTickerMessage,
} from './assetTickerPolicy';
import { useStaleRecheck } from './useStaleRecheck';

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

// The ticker shape and the accept/stale rules are shared with the market list;
// re-exported here so existing `useAssetTicker` imports keep working.
export type { AssetTickerMessage } from './assetTickerPolicy';

type AssetTickerControlMessage = {
  type?: string;
  channel?: string;
  assetId?: string;
  code?: string;
  message?: string;
};

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
  const acceptStateRef = useRef<AssetTickerAcceptState | null>(null);

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

      const current = acceptStateRef.current;
      const next = applyTicker(current, payload);
      // Rejected by the shared policy (duplicate snapshot / older timestamp /
      // unorderable priced event): keep the last accepted ticker as-is.
      if (next === current) return;

      acceptStateRef.current = next;
      setLatestTicker(next?.ticker ?? null);
      setIsStale(isTickerStaleAt(next?.ticker ?? null, Date.now()));
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
      acceptStateRef.current = null;
      unsubscribe();
    };
  }, [assetId, wsUrl, enabled]);

  // Staleness must also advance with the CLOCK: while this screen holds a
  // ticker (and the app is foregrounded) the last accepted one is re-judged
  // on an interval, so a feed that simply stops still turns stale.
  useStaleRecheck(!!latestTicker, () => {
    setIsStale(isTickerStaleAt(acceptStateRef.current?.ticker ?? null, Date.now()));
  });

  return {
    connectionState,
    latestTicker,
    showReconnectBanner,
    isStale,
  };
}
