import { useEffect, useState } from 'react';
import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager';
import {
  realtimeRuntimeFacts,
  runtimeTime,
  safeRuntimeCode,
  type RealtimeRuntimeSnapshot,
} from '../../services/ws/runtimeDiagnostics';
import {
  ESTIMATED_QUOTE_FIRST_SNAPSHOT_TIMEOUT_MS,
  ESTIMATED_QUOTE_STALE_MS,
  isEstimatedQuoteStale,
  parseAssetEstimatedQuote,
  type AssetEstimatedQuote,
} from './estimatedQuote';
import { useStaleRecheck } from './useStaleRecheck';

type ConnectionState =
  | 'connecting'
  | 'subscribing'
  | 'subscribed'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failed'
  | 'subscription_error';

type QuoteState = {
  assetId: string;
  wsUrl: string;
  quote: AssetEstimatedQuote | null;
  receivedAt: number | null;
  subscribedAt: number | null;
  connectionState: ConnectionState;
  errorCode: string | null;
  realtime: RealtimeRuntimeSnapshot | null;
  lastAckAt: number | null;
  lastRejectionReason: string | null;
};

function initial(assetId: string, wsUrl: string): QuoteState {
  return {
    assetId,
    wsUrl,
    quote: null,
    receivedAt: null,
    subscribedAt: null,
    connectionState: 'connecting',
    errorCode: null,
    realtime: null,
    lastAckAt: null,
    lastRejectionReason: null,
  };
}

/**
 * Estimated best bid/ask subscription (separate from the order-book ladder).
 * The server decides which assets have an estimate source: an unsupported
 * asset answers UNSUPPORTED_ASSET and the caller renders nothing.
 */
export function useAssetEstimatedQuote({
  assetId,
  wsUrl,
  enabled = true,
}: {
  assetId: string;
  wsUrl: string;
  enabled?: boolean;
}) {
  const [state, setState] = useState<QuoteState>(() => initial(assetId, wsUrl));
  const [now, setNow] = useState(Date.now);
  const active = enabled && !!assetId && !!wsUrl;

  useEffect(() => {
    setState({
      ...initial(assetId, wsUrl),
      connectionState: active ? 'connecting' : 'disconnected',
    });
    if (!active) return undefined;
    let mounted = true;
    const onEvent = (event: RealtimeSubscriptionEvent) => {
      if (!mounted) return;
      if (event.kind === 'runtime') {
        setState((current) => ({ ...current, realtime: event.runtime }));
        return;
      }
      if (event.kind === 'status') {
        const connectionState: ConnectionState =
          event.status === 'connected'
            ? 'subscribing'
            : event.status === 'idle'
              ? 'disconnected'
              : event.status;
        setState((current) => ({
          ...current,
          connectionState,
          subscribedAt: null,
          errorCode: null,
        }));
        return;
      }
      if (event.kind === 'restored') return;
      const payload = event.payload;
      if (payload.type === 'asset_estimated_quote') {
        const receivedAt = Date.now();
        const quote = parseAssetEstimatedQuote(payload, assetId);
        if (!quote) {
          if (payload.assetId === assetId)
            setState((current) => ({
              ...current,
              lastRejectionReason: 'invalid_estimate',
            }));
          return;
        }
        setNow(receivedAt);
        setState((current) =>
          current.quote &&
          Date.parse(current.quote.capturedAt) > Date.parse(quote.capturedAt)
            ? { ...current, lastRejectionReason: 'older_estimate' }
            : {
                ...current,
                quote,
                receivedAt,
                subscribedAt: null,
                connectionState: 'subscribed',
                errorCode: null,
              },
        );
        return;
      }
      if (
        payload.channel !== 'asset_estimated_quote' ||
        payload.assetId !== assetId
      )
        return;
      if (payload.type === 'subscribed') {
        const acknowledgedAt = Date.now();
        setState((current) => ({
          ...current,
          connectionState: 'subscribed',
          errorCode: null,
          lastAckAt: acknowledgedAt,
          subscribedAt: current.quote
            ? null
            : (current.subscribedAt ?? acknowledgedAt),
        }));
      } else if (
        payload.type === 'subscription_error' ||
        payload.type === 'error'
      ) {
        setState((current) => ({
          ...current,
          connectionState: 'subscription_error',
          subscribedAt: null,
          errorCode: payload.code ?? 'INVALID_SUBSCRIPTION',
        }));
      }
    };
    const unsubscribe = getRealtimeSocketManager(wsUrl).subscribe(
      { channel: 'asset_estimated_quote', assetId },
      onEvent,
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [assetId, wsUrl, active]);

  // Hide the previous asset synchronously, before the effect resets state.
  const current =
    active && state.assetId === assetId && state.wsUrl === wsUrl
      ? state
      : initial(assetId, wsUrl);
  const localNow = Math.max(now, Date.now());
  const connectionState = active ? current.connectionState : 'disconnected';
  const unsupported =
    connectionState === 'subscription_error' &&
    current.errorCode === 'UNSUPPORTED_ASSET';
  const waitingSince =
    connectionState === 'subscribed' && !current.quote
      ? current.subscribedAt
      : null;
  const isUnavailable =
    waitingSince !== null &&
    localNow - waitingSince >= ESTIMATED_QUOTE_FIRST_SNAPSHOT_TIMEOUT_MS;
  useStaleRecheck(
    active && (!!current.quote || (waitingSince !== null && !isUnavailable)),
    () => setNow(Date.now()),
    1_000,
  );
  const isStale = isEstimatedQuoteStale(
    current.quote,
    current.receivedAt,
    localNow,
  );
  const statusMessage =
    connectionState === 'auth_failed'
      ? '로그인 상태를 확인해주세요.'
      : connectionState === 'subscription_error'
        ? '추정 호가를 구독할 수 없습니다.'
        : connectionState === 'reconnecting' ||
            connectionState === 'disconnected'
          ? '추정 호가 연결을 복구하는 중입니다.'
          : isUnavailable
            ? '현재 표시할 추정 호가가 없습니다.'
            : isStale
              ? '추정 호가가 지연되고 있습니다.'
              : !current.quote
                ? '추정 호가를 불러오는 중입니다.'
                : null;
  return {
    latestEstimate: current.quote,
    /** True once the server accepted the subscription (estimate source exists). */
    supported:
      !unsupported &&
      (current.quote !== null || current.lastAckAt !== null),
    unsupported,
    connectionState,
    isStale,
    isUnavailable,
    statusMessage,
    runtime: {
      ...realtimeRuntimeFacts(current.realtime),
      assetId,
      channel: 'asset_estimated_quote',
      connectionState,
      lastAckReceivedAt: runtimeTime(current.lastAckAt),
      lastEstimateAcceptedAt: runtimeTime(current.receivedAt),
      lastEstimateCapturedAt: current.quote?.capturedAt,
      lastRejectionReason: current.lastRejectionReason,
      subscriptionErrorCode:
        current.realtime?.subscription.lastSubscriptionErrorCode ??
        (current.errorCode
          ? (safeRuntimeCode(current.errorCode) ?? 'not_observed')
          : null),
      firstSnapshotTimeoutMs: ESTIMATED_QUOTE_FIRST_SNAPSHOT_TIMEOUT_MS,
      firstSnapshotTimedOut: isUnavailable,
      staleThresholdMs: ESTIMATED_QUOTE_STALE_MS,
      freshnessBasis: 'client_receipt',
      isStale,
    },
  };
}
