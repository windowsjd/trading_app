import { useEffect, useRef, useState } from "react";

import { getRealtimeSocketManager } from "../../services/ws/sharedRealtimeSocket";
import type { RealtimeSubscriptionEvent } from "../../services/ws/realtimeSocketManager";
import type { AssetCandleInterval } from "./chartTimeframes";
import {
  isLiveAssetCandleInterval,
  parseAssetCandleSnapshot,
  type AssetCandleSnapshotMessage,
} from "./liveCandle";

interface UseAssetCandleParams {
  assetId: string;
  interval: AssetCandleInterval;
  wsUrl: string;
  enabled?: boolean;
}

const STALE_AFTER_MS = 30_000;

/**
 * Subscribes to the asset_candle channel on the app-wide shared WebSocket
 * (one socket per app session, shared with useAssetTicker). Reconnects are
 * owned by the manager; this hook resets its sequence tracking and bumps
 * resyncVersion whenever its subscription is restored on a new socket so the
 * screen refetches its HTTP candle baseline.
 */
export function useAssetCandle({
  assetId,
  interval,
  wsUrl,
  enabled = true,
}: UseAssetCandleParams) {
  const staleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSequenceRef = useRef(-1);
  const latestRevisionRef = useRef(-1);
  const [latestCandle, setLatestCandle] =
    useState<AssetCandleSnapshotMessage | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [resyncVersion, setResyncVersion] = useState(0);
  const liveEnabled =
    enabled && !!assetId && !!wsUrl && isLiveAssetCandleInterval(interval);

  useEffect(() => {
    setLatestCandle(null);
    setIsStale(false);
    latestSequenceRef.current = -1;
    latestRevisionRef.current = -1;
    if (!liveEnabled) return undefined;

    let mounted = true;

    const clearStaleTimer = () => {
      if (staleRef.current) clearTimeout(staleRef.current);
      staleRef.current = null;
    };
    const scheduleStale = (sourceUpdatedAt?: string) => {
      clearStaleTimer();
      const timestamp = sourceUpdatedAt
        ? Date.parse(sourceUpdatedAt)
        : Date.now();
      const delay = Math.max(0, timestamp + STALE_AFTER_MS - Date.now());
      staleRef.current = setTimeout(() => setIsStale(true), delay);
    };

    const onEvent = (event: RealtimeSubscriptionEvent) => {
      if (!mounted) return;

      if (event.kind === "status") {
        if (event.status === "connected") {
          scheduleStale();
          return;
        }
        if (
          event.status === "reconnecting" ||
          event.status === "disconnected" ||
          event.status === "auth_failed"
        ) {
          setIsStale(true);
        }
        return;
      }

      if (event.kind === "restored") {
        // A new socket carries a fresh server sequence space; drop local
        // ordering state and ask the screen to refetch its HTTP baseline.
        latestSequenceRef.current = -1;
        latestRevisionRef.current = -1;
        setResyncVersion((value) => value + 1);
        return;
      }

      const payload = event.payload;
      const control = payload as {
        type?: unknown;
        channel?: unknown;
        assetId?: unknown;
        interval?: unknown;
      };
      if (
        control.channel === "asset_candle" &&
        control.assetId === assetId &&
        control.interval === interval
      ) {
        if (control.type === "resync_required") {
          setResyncVersion((value) => value + 1);
          setIsStale(true);
          return;
        }
        if (
          control.type === "candle_stale" ||
          control.type === "subscription_error"
        ) {
          setIsStale(true);
          return;
        }
      }
      const snapshot = parseAssetCandleSnapshot(payload, {
        assetId,
        interval,
      });
      if (!snapshot) return;
      if (
        snapshot.sequence < latestSequenceRef.current ||
        (snapshot.sequence === latestSequenceRef.current &&
          snapshot.revision <= latestRevisionRef.current)
      ) {
        return;
      }
      latestSequenceRef.current = snapshot.sequence;
      latestRevisionRef.current = snapshot.revision;
      setLatestCandle(snapshot);
      setIsStale(false);
      // A delayed KIS trade is expected to carry an older exchange time.
      // Its transport freshness is measured from receipt on the client,
      // while the UI still exposes the delayed flag explicitly.
      scheduleStale(snapshot.delayed ? undefined : snapshot.sourceUpdatedAt);
    };

    const manager = getRealtimeSocketManager(wsUrl);
    const unsubscribe = manager.subscribe(
      { channel: "asset_candle", assetId, interval },
      onEvent,
    );

    return () => {
      mounted = false;
      clearStaleTimer();
      unsubscribe();
    };
  }, [assetId, interval, wsUrl, liveEnabled]);

  return { latestCandle, isStale, resyncVersion, liveEnabled };
}
