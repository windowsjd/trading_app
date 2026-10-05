import type { RealtimeSocketStatus } from './realtimeSocketManager.ts';

export type RuntimeFacts = Record<
  string,
  string | number | boolean | null | undefined
>;
export type TransportTransitionReason =
  | 'initial_connect'
  | 'socket_open'
  | 'socket_closed'
  | 'reconnect_started'
  | 'auth_failed_close'
  | 'auth_failed_control'
  | 'socket_create_failed'
  | 'token_load_failed'
  | 'manual_token_refresh'
  | 'no_subscribers_teardown';

/** Fixed-size, memory-only evidence. Never contains URLs, tokens or raw errors. */
export type SocketRuntime = {
  currentStatus: RealtimeSocketStatus;
  lastTransitionReason: TransportTransitionReason | null;
  lastTransitionAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastCloseCode: number | null;
  reconnectAttempt: number;
  nextReconnectDelayMs: number | null;
  reconnectScheduledAt: number | null;
  authFailureSource:
    | 'close_1008'
    | 'auth_failed_control'
    | 'unauthorized_control'
    | null;
  lastTokenLoadFailedAt: number | null;
  activeSubscriptionCount: number;
};

export type SubscriptionRuntime = {
  subscriptionSent: boolean;
  subscriptionAcked: boolean;
  subscriptionSentAt: number | null;
  acknowledgedAt: number | null;
  lastRestoredAt: number | null;
  subscriptionError: boolean;
  lastSubscriptionErrorCode: string | null;
  lastSubscriptionErrorAt: number | null;
  lastSubscriptionErrorScope: 'subscription' | 'unscoped_control' | null;
};

export type RealtimeRuntimeSnapshot = {
  socket: SocketRuntime;
  subscription: SubscriptionRuntime;
};

// Only protocol constants that this app knows are safe to display. Unknown
// codes are explicitly unobserved; even a syntactically plausible credential
// or a future free-text provider error must never enter a diagnostic panel.
const SAFE_CODES = new Set([
  'INVALID_INTERVAL',
  'ASSET_NOT_AVAILABLE',
  'UNAUTHORIZED',
  'INVALID_SUBSCRIPTION',
  'SUBSCRIPTION_LIMIT',
  'UNSUPPORTED_ASSET',
  'ORDER_BOOK_UNAVAILABLE',
  'TICKER_POLL_FAILED',
  'TICKER_SNAPSHOT_FAILED',
  'ASSET_PRICE_UNAVAILABLE',
  'ASSET_PRICE_STALE',
  'PRICE_STALE',
  'FX_RATE_UNAVAILABLE',
  'FX_RATE_STALE',
  'MARKET_CLOSED',
  'MARKET_STATUS_UNKNOWN',
  'THROTTLED_PROVIDER_SNAPSHOT',
  'CANDLE_OVERLAY_READ_FAILED',
  'CANDLE_PUBSUB_UNAVAILABLE',
  'CANDLE_PUBSUB_RECOVERED',
]);

export function safeRuntimeCode(value: unknown): string | null {
  return typeof value === 'string' && SAFE_CODES.has(value) ? value : null;
}

export function runtimeTime(value: number | null | undefined): string | null {
  return value == null || !Number.isFinite(value)
    ? null
    : new Date(value).toISOString();
}

export function socketRuntimeFacts(
  socket?: SocketRuntime | null,
): RuntimeFacts {
  if (!socket) return { socketStatus: 'not_observed' };
  return {
    socketStatus: socket.currentStatus,
    lastTransitionReason: socket.lastTransitionReason ?? 'not_observed',
    lastTransitionAt: runtimeTime(socket.lastTransitionAt),
    lastConnectedAt: runtimeTime(socket.lastConnectedAt),
    lastDisconnectedAt: runtimeTime(socket.lastDisconnectedAt),
    lastCloseCode: socket.lastCloseCode,
    reconnectAttempt: socket.reconnectAttempt,
    nextReconnectDelayMs: socket.nextReconnectDelayMs,
    reconnectScheduledAt: runtimeTime(socket.reconnectScheduledAt),
    authFailureSource: socket.authFailureSource,
    lastTokenLoadFailedAt: runtimeTime(socket.lastTokenLoadFailedAt),
    activeSubscriptionCount: socket.activeSubscriptionCount,
  };
}

export function realtimeRuntimeFacts(
  runtime?: RealtimeRuntimeSnapshot | null,
): RuntimeFacts {
  if (!runtime)
    return { socketStatus: 'not_observed', subscriptionAcked: 'not_observed' };
  const { socket, subscription } = runtime;
  return {
    ...socketRuntimeFacts(socket),
    subscriptionSent: subscription.subscriptionSent,
    subscriptionAcked: subscription.subscriptionAcked,
    subscriptionSentAt: runtimeTime(subscription.subscriptionSentAt),
    acknowledgedAt: runtimeTime(subscription.acknowledgedAt),
    lastRestoredAt: runtimeTime(subscription.lastRestoredAt),
    subscriptionError: subscription.subscriptionError,
    lastSubscriptionErrorCode: subscription.lastSubscriptionErrorCode,
    lastSubscriptionErrorAt: runtimeTime(subscription.lastSubscriptionErrorAt),
    lastSubscriptionErrorScope: subscription.lastSubscriptionErrorScope,
  };
}
