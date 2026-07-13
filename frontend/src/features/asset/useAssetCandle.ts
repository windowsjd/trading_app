import { useEffect, useRef, useState } from "react";

import { getAccessToken } from "../../services/storage/tokenStorage";
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

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const STALE_AFTER_MS = 30_000;

export function useAssetCandle({
  assetId,
  interval,
  wsUrl,
  enabled = true,
}: UseAssetCandleParams) {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);
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
    shouldReconnectRef.current = true;

    const clearTimers = () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (staleRef.current) clearTimeout(staleRef.current);
      reconnectRef.current = null;
      staleRef.current = null;
    };
    const scheduleStale = (sourceUpdatedAt?: string) => {
      if (staleRef.current) clearTimeout(staleRef.current);
      const timestamp = sourceUpdatedAt
        ? Date.parse(sourceUpdatedAt)
        : Date.now();
      const delay = Math.max(0, timestamp + STALE_AFTER_MS - Date.now());
      staleRef.current = setTimeout(() => setIsStale(true), delay);
    };
    const send = (ws: WebSocket, type: "subscribe" | "unsubscribe") => {
      try {
        ws.send(
          JSON.stringify({
            type,
            channel: "asset_candle",
            assetId,
            interval,
          }),
        );
      } catch {
        // Best effort during reconnect/cleanup.
      }
    };
    const scheduleReconnect = () => {
      if (!mounted || !shouldReconnectRef.current) return;
      setIsStale(true);
      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS_MS.length - 1)
        ];
      reconnectAttemptRef.current += 1;
      reconnectRef.current = setTimeout(connect, delay);
    };
    const connect = async () => {
      if (!mounted || !shouldReconnectRef.current) return;
      const token = await getAccessToken();
      if (!mounted || !shouldReconnectRef.current) return;
      const separator = wsUrl.includes("?") ? "&" : "?";
      const url = token
        ? `${wsUrl}${separator}token=${encodeURIComponent(token)}`
        : wsUrl;
      const ws = new WebSocket(url);
      socketRef.current = ws;
      ws.onopen = () => {
        if (!mounted) return;
        const reconnecting = reconnectAttemptRef.current > 0;
        reconnectAttemptRef.current = 0;
        latestSequenceRef.current = -1;
        latestRevisionRef.current = -1;
        if (reconnecting) setResyncVersion((value) => value + 1);
        send(ws, "subscribe");
        scheduleStale();
      };
      ws.onmessage = (event) => {
        if (!mounted) return;
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
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
      ws.onerror = () => setIsStale(true);
      ws.onclose = (event) => {
        if (!mounted) return;
        if (event.code === 1008) {
          shouldReconnectRef.current = false;
          setIsStale(true);
          return;
        }
        scheduleReconnect();
      };
    };
    void connect();

    return () => {
      mounted = false;
      shouldReconnectRef.current = false;
      clearTimers();
      if (socketRef.current) {
        send(socketRef.current, "unsubscribe");
        socketRef.current.close();
      }
      socketRef.current = null;
    };
  }, [assetId, interval, wsUrl, liveEnabled]);

  return { latestCandle, isStale, resyncVersion, liveEnabled };
}
