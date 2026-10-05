import { useEffect, useRef, useState } from "react";

import { getRealtimeSocketManager } from "../../services/ws/sharedRealtimeSocket";
import type { RealtimeSubscriptionEvent } from "../../services/ws/realtimeSocketManager";
import {
  realtimeRuntimeFacts,
  runtimeTime,
  safeRuntimeCode,
  type RealtimeRuntimeSnapshot,
} from "../../services/ws/runtimeDiagnostics";
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
type CandleEvidence = {
  staleReason: string | null;
  lastControlType: string | null;
  lastControlCode: string | null;
  lastControlAt: number | null;
  lastSnapshotReceivedAt: number | null;
  lastSnapshotAcceptedAt: number | null;
  lastSourceUpdatedAt: string | null;
  lastRejectionReason: string | null;
  lastResyncReason: string | null;
  lastResyncAt: number | null;
  delayed: boolean | null;
  freshnessBasis: "client_receipt" | "source_updated_at" | null;
};
const EMPTY_EVIDENCE: CandleEvidence = {
  staleReason: null,
  lastControlType: null,
  lastControlCode: null,
  lastControlAt: null,
  lastSnapshotReceivedAt: null,
  lastSnapshotAcceptedAt: null,
  lastSourceUpdatedAt: null,
  lastRejectionReason: null,
  lastResyncReason: null,
  lastResyncAt: null,
  delayed: null,
  freshnessBasis: null,
};

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
  const [realtime, setRealtime] = useState<RealtimeRuntimeSnapshot | null>(
    null,
  );
  const [evidence, setEvidence] = useState(EMPTY_EVIDENCE);
  const liveEnabled =
    enabled && !!assetId && !!wsUrl && isLiveAssetCandleInterval(interval);

  useEffect(() => {
    setRealtime(null);
    setEvidence(EMPTY_EVIDENCE);
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
      staleRef.current = setTimeout(() => {
        setIsStale(true);
        setEvidence((current) => ({
          ...current,
          staleReason: current.staleReason ?? "freshness_timeout",
        }));
      }, delay);
    };

    const onEvent = (event: RealtimeSubscriptionEvent) => {
      if (!mounted) return;

      if (event.kind === "runtime") {
        setRealtime(event.runtime);
        return;
      }
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
          setEvidence((current) => ({
            ...current,
            staleReason:
              event.status === "auth_failed"
                ? "auth_failed"
                : `socket_${event.status}`,
          }));
        }
        return;
      }

      if (event.kind === "restored") {
        // A new socket carries a fresh server sequence space; drop local
        // ordering state and ask the screen to refetch its HTTP baseline.
        latestSequenceRef.current = -1;
        latestRevisionRef.current = -1;
        setResyncVersion((value) => value + 1);
        setEvidence((current) => ({
          ...current,
          lastResyncReason: "reconnect_restored_resync",
          lastResyncAt: Date.now(),
          staleReason: current.staleReason ? "reconnect_restored_resync" : null,
        }));
        return;
      }

      const payload = event.payload;
      const control = payload as {
        type?: unknown;
        channel?: unknown;
        assetId?: unknown;
        interval?: unknown;
        code?: unknown;
      };
      if (
        control.channel === "asset_candle" &&
        control.assetId === assetId &&
        control.interval === interval
      ) {
        if (
          control.type === "subscribed" ||
          control.type === "subscription_error" ||
          control.type === "candle_stale" ||
          control.type === "resync_required"
        ) {
          const controlType = control.type;
          setEvidence((current) => ({
            ...current,
            lastControlType: controlType,
            lastControlCode: safeRuntimeCode(control.code),
            lastControlAt: Date.now(),
          }));
        }
        if (control.type === "resync_required") {
          setResyncVersion((value) => value + 1);
          setIsStale(true);
          setEvidence((current) => ({
            ...current,
            staleReason: "resync_required",
            lastResyncReason: "resync_required",
            lastResyncAt: Date.now(),
          }));
          return;
        }
        if (
          control.type === "candle_stale" ||
          control.type === "subscription_error"
        ) {
          setIsStale(true);
          setEvidence((current) => ({
            ...current,
            staleReason:
              control.type === "candle_stale"
                ? "server_candle_stale"
                : "subscription_error",
          }));
          return;
        }
      }
      const receivedAt = Date.now();
      const matchingSnapshot =
        control.type === "asset_candle" &&
        control.assetId === assetId &&
        control.interval === interval;
      if (matchingSnapshot)
        setEvidence((current) => ({
          ...current,
          lastSnapshotReceivedAt: receivedAt,
        }));
      const snapshot = parseAssetCandleSnapshot(payload, {
        assetId,
        interval,
      });
      if (!snapshot) {
        if (matchingSnapshot)
          setEvidence((current) => ({
            ...current,
            lastRejectionReason: "invalid_snapshot",
          }));
        return;
      }
      if (
        snapshot.sequence < latestSequenceRef.current ||
        (snapshot.sequence === latestSequenceRef.current &&
          snapshot.revision <= latestRevisionRef.current)
      ) {
        setEvidence((current) => ({
          ...current,
          lastRejectionReason: "duplicate_or_older_sequence_revision",
        }));
        return;
      }
      latestSequenceRef.current = snapshot.sequence;
      latestRevisionRef.current = snapshot.revision;
      setLatestCandle(snapshot);
      setIsStale(false);
      setEvidence((current) => ({
        ...current,
        staleReason: null,
        lastSnapshotAcceptedAt: receivedAt,
        lastSourceUpdatedAt: runtimeTime(Date.parse(snapshot.sourceUpdatedAt)),
        delayed: snapshot.delayed,
        freshnessBasis: snapshot.delayed
          ? "client_receipt"
          : "source_updated_at",
      }));
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

  return {
    latestCandle,
    isStale,
    resyncVersion,
    liveEnabled,
    runtime: {
      ...realtimeRuntimeFacts(realtime),
      assetId,
      channel: "asset_candle",
      interval,
      candleStale: isStale,
      staleReason: isStale ? evidence.staleReason : null,
      lastControlType: evidence.lastControlType,
      lastControlCode: evidence.lastControlCode,
      lastControlAt: runtimeTime(evidence.lastControlAt),
      lastSnapshotReceivedAt: runtimeTime(evidence.lastSnapshotReceivedAt),
      lastSnapshotAcceptedAt: runtimeTime(evidence.lastSnapshotAcceptedAt),
      lastSourceUpdatedAt: evidence.lastSourceUpdatedAt,
      lastRejectionReason: evidence.lastRejectionReason,
      staleThresholdMs: STALE_AFTER_MS,
      freshnessBasis: evidence.freshnessBasis,
      delayed: evidence.delayed,
      resyncVersion,
      lastResyncReason: evidence.lastResyncReason,
      lastResyncAt: runtimeTime(evidence.lastResyncAt),
    },
  };
}
