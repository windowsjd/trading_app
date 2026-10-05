import {
  safeRuntimeCode,
  type RealtimeRuntimeSnapshot,
  type SocketRuntime,
  type SubscriptionRuntime,
  type TransportTransitionReason,
} from './runtimeDiagnostics.ts';

/**
 * App-wide shared authenticated WebSocket for /api/v1/ws.
 *
 * One socket per URL carries every realtime channel (asset_ticker,
 * asset_candle). Hooks register reference-counted subscriptions; the manager
 * owns connect/reconnect/backoff, token loading, subscription restoration
 * after reconnects, and message routing. The socket closes only when the
 * last subscription is released, and auth failures (1008 / UNAUTHORIZED)
 * stop reconnection entirely until a fresh subscription or an explicit
 * reconnectWithFreshToken() call.
 */

export type RealtimeChannel =
  | 'asset_ticker'
  | 'asset_candle'
  | 'asset_order_book'
  | 'fx_rate';

export type RealtimeSubscriptionSpec =
  | {
      channel: 'asset_ticker' | 'asset_candle' | 'asset_order_book';
      assetId: string;
      interval?: string;
      pair?: never;
    }
  | {
      channel: 'fx_rate';
      pair: 'USD/KRW';
      assetId?: never;
      interval?: never;
    };

export type RealtimeSocketStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failed';

export type RealtimeSubscriptionEvent =
  | { kind: 'status'; status: RealtimeSocketStatus }
  // Diagnostic-only updates must not re-run status-driven timers or resyncs.
  | { kind: 'runtime'; runtime: RealtimeRuntimeSnapshot }
  // The subscription was re-sent on a NEW socket after a reconnect; consumers
  // should resync their baselines (e.g. HTTP refetch for candles).
  | { kind: 'restored' }
  | { kind: 'message'; payload: RoutedPayload };

export type RealtimeSubscriptionListener = (
  event: RealtimeSubscriptionEvent,
) => void;

type RoutedPayload = {
  type?: string;
  channel?: string;
  assetId?: string;
  interval?: string;
  pair?: string;
  code?: string;
  [key: string]: unknown;
};

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
}

export interface RealtimeSocketManagerDeps {
  createSocket: (url: string) => WebSocketLike;
  getToken: () => Promise<string | null>;
  reconnectDelaysMs?: readonly number[];
}

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const;

type SubscriptionEntry = {
  spec: RealtimeSubscriptionSpec;
  listeners: Set<RealtimeSubscriptionListener>;
  sent: boolean;
  acked: boolean;
  runtime: Omit<SubscriptionRuntime, 'subscriptionSent' | 'subscriptionAcked'>;
};

function subscriptionKey(spec: RealtimeSubscriptionSpec): string {
  return `${spec.channel}|${spec.assetId ?? spec.pair}|${spec.interval ?? ''}`;
}

function appendToken(wsUrl: string, token: string | null): string {
  if (!token) return wsUrl;
  const separator = wsUrl.includes('?') ? '&' : '?';
  return `${wsUrl}${separator}token=${encodeURIComponent(token)}`;
}

export class RealtimeSocketManager {
  private readonly subscriptions = new Map<string, SubscriptionEntry>();
  private socket: WebSocketLike | null = null;
  private status: RealtimeSocketStatus = 'idle';
  private runtime: Omit<
    SocketRuntime,
    'currentStatus' | 'reconnectAttempt' | 'activeSubscriptionCount'
  > = {
    lastTransitionReason: null,
    lastTransitionAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastCloseCode: null,
    nextReconnectDelayMs: null,
    reconnectScheduledAt: null,
    authFailureSource: null,
    lastTokenLoadFailedAt: null,
  };
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasConnectedBefore = false;
  private authFailed = false;
  private connectSequence = 0;
  private readonly wsUrl: string;
  private readonly deps: RealtimeSocketManagerDeps;
  private readonly reconnectDelaysMs: readonly number[];

  // Node's type-stripping test runner cannot handle parameter properties, so
  // fields are assigned explicitly.
  constructor(wsUrl: string, deps: RealtimeSocketManagerDeps) {
    this.wsUrl = wsUrl;
    this.deps = deps;
    this.reconnectDelaysMs =
      deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  /** Registers a listener; returns an unsubscribe function. */
  subscribe(
    spec: RealtimeSubscriptionSpec,
    listener: RealtimeSubscriptionListener,
  ): () => void {
    const key = subscriptionKey(spec);
    let entry = this.subscriptions.get(key);
    if (!entry) {
      entry = {
        spec,
        listeners: new Set(),
        sent: false,
        acked: false,
        runtime: {
          subscriptionSentAt: null,
          acknowledgedAt: null,
          lastRestoredAt: null,
          subscriptionError: false,
          lastSubscriptionErrorCode: null,
          lastSubscriptionErrorAt: null,
          lastSubscriptionErrorScope: null,
        },
      };
      this.subscriptions.set(key, entry);
    }
    entry.listeners.add(listener);

    // A fresh subscription clears a previous terminal auth failure so a
    // newly signed-in session can connect again.
    if (this.authFailed && !this.socket) {
      this.authFailed = false;
      this.reconnectAttempt = 0;
    }

    // Late joiners immediately learn the current socket status, and replay
    // the ack when the shared subscription is already established.
    this.emitToListener(listener, { kind: 'status', status: this.status });
    this.emitRuntime();
    if (this.status === 'connected') {
      if (entry.acked) {
        this.emitToListener(listener, {
          kind: 'message',
          payload: {
            type: 'subscribed',
            channel: entry.spec.channel,
            ...(entry.spec.channel === 'fx_rate'
              ? { pair: entry.spec.pair }
              : { assetId: entry.spec.assetId }),
            ...(entry.spec.interval ? { interval: entry.spec.interval } : {}),
          },
        });
      } else if (!entry.sent) {
        this.sendSubscription(entry, 'subscribe');
      }
    }

    this.ensureConnected();
    return () => this.removeListener(key, listener);
  }

  /** Force-closes and reconnects with a freshly loaded token. */
  reconnectWithFreshToken(): void {
    this.authFailed = false;
    this.runtime.authFailureSource = null;
    this.reconnectAttempt = 0;
    if (this.socket) {
      const socket = this.socket;
      this.runtime.lastDisconnectedAt = Date.now();
      this.detachSocket();
      try {
        socket.close(1000, 'token refresh');
      } catch {
        // Already closed.
      }
    }
    this.clearReconnectTimer();
    if (this.subscriptions.size > 0) void this.connect('manual_token_refresh');
  }

  getStatus(): RealtimeSocketStatus {
    return this.status;
  }

  getRuntimeSnapshot(): SocketRuntime {
    return {
      ...this.runtime,
      currentStatus: this.status,
      reconnectAttempt: this.reconnectAttempt,
      activeSubscriptionCount: this.subscriptions.size,
    };
  }

  getSubscriptionRuntime(
    spec: RealtimeSubscriptionSpec,
  ): RealtimeRuntimeSnapshot | null {
    const entry = this.subscriptions.get(subscriptionKey(spec));
    return entry ? this.snapshotFor(entry) : null;
  }

  hasOpenSocket(): boolean {
    return this.socket !== null;
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  private removeListener(
    key: string,
    listener: RealtimeSubscriptionListener,
  ): void {
    const entry = this.subscriptions.get(key);
    if (!entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;

    this.subscriptions.delete(key);
    if (entry.sent && this.status === 'connected') {
      this.sendSubscription(entry, 'unsubscribe');
    }
    if (this.subscriptions.size === 0) this.teardown();
    else this.emitRuntime();
  }

  private ensureConnected(): void {
    if (this.socket || this.reconnectTimer || this.authFailed) return;
    if (this.subscriptions.size === 0) return;
    void this.connect();
  }

  private async connect(reason?: TransportTransitionReason): Promise<void> {
    if (this.socket || this.authFailed) return;
    const sequence = (this.connectSequence += 1);
    this.setStatus(
      this.hasConnectedBefore ? 'reconnecting' : 'connecting',
      reason ??
        (this.hasConnectedBefore ? 'reconnect_started' : 'initial_connect'),
    );
    let tokenLoadFailed = false;

    let token: string | null = null;
    try {
      token = await this.deps.getToken();
    } catch {
      token = null;
      tokenLoadFailed = true;
    }
    // The manager may have been torn down or superseded while awaiting.
    if (sequence !== this.connectSequence || this.subscriptions.size === 0) {
      return;
    }

    if (tokenLoadFailed) {
      this.runtime.lastTokenLoadFailedAt = Date.now();
      this.recordTransition('token_load_failed');
      this.emitRuntime();
    }

    let socket: WebSocketLike;
    try {
      socket = this.deps.createSocket(appendToken(this.wsUrl, token));
    } catch {
      this.recordTransition('socket_create_failed');
      this.emitRuntime();
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      const wasReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.reconnectAttempt = 0;
      this.runtime.lastConnectedAt = Date.now();
      this.runtime.authFailureSource = null;
      this.setStatus('connected', 'socket_open');
      for (const entry of this.subscriptions.values()) {
        entry.acked = false;
        if (wasReconnect) entry.runtime.lastRestoredAt = Date.now();
        this.sendSubscription(entry, 'subscribe');
        if (wasReconnect) {
          this.emitToEntry(entry, { kind: 'restored' });
        }
      }
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let payload: RoutedPayload;
      try {
        payload = JSON.parse(event.data) as RoutedPayload;
      } catch {
        return;
      }
      this.route(payload);
    };

    socket.onerror = () => {
      // The close handler drives reconnection; error alone is not terminal.
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.runtime.lastDisconnectedAt = Date.now();
      this.runtime.lastCloseCode = Number.isInteger(event?.code)
        ? event.code
        : null;
      this.detachSocket();
      if (event?.code === 1008) {
        this.failAuth('close_1008');
        return;
      }
      this.setStatus('disconnected', 'socket_closed');
      this.scheduleReconnect();
    };
  }

  private route(payload: RoutedPayload): void {
    if (
      payload.type === 'auth_failed' ||
      (payload.type === 'error' && payload.code === 'UNAUTHORIZED')
    ) {
      const socket = this.socket;
      this.detachSocket();
      this.runtime.lastDisconnectedAt = Date.now();
      this.failAuth(
        payload.type === 'auth_failed'
          ? 'auth_failed_control'
          : 'unauthorized_control',
      );
      try {
        socket?.close();
      } catch {
        // Already closed.
      }
      return;
    }

    if (payload.type === 'subscribed' && typeof payload.channel === 'string') {
      const entry = this.findEntry(payload);
      if (entry) {
        entry.acked = true;
        entry.runtime.acknowledgedAt = Date.now();
        entry.runtime.subscriptionError = false;
        this.emitEntryRuntime(entry);
      }
    }

    if (payload.type === 'asset_ticker') {
      this.emitToMatches('asset_ticker', payload, true);
      return;
    }
    if (payload.type === 'asset_candle') {
      this.emitToMatches('asset_candle', payload, true);
      return;
    }
    if (payload.type === 'asset_order_book') {
      if (typeof payload.assetId === 'string' && payload.assetId) {
        this.emitToMatches('asset_order_book', payload, false);
      }
      return;
    }
    if (payload.type === 'fx_rate_updated') {
      this.emitToMatches('fx_rate', payload, true);
      return;
    }
    if (
      payload.channel === 'asset_ticker' ||
      payload.channel === 'asset_candle' ||
      payload.channel === 'asset_order_book' ||
      payload.channel === 'fx_rate'
    ) {
      this.emitToMatches(payload.channel, payload, false);
      return;
    }
    // Channel-less control/error messages cannot be attributed: let every
    // subscription apply its own relevance rules (matches previous per-hook
    // behavior for e.g. INVALID_SUBSCRIPTION).
    for (const entry of this.subscriptions.values()) {
      this.recordSubscriptionError(entry, payload);
      this.emitToEntry(entry, { kind: 'message', payload });
    }
  }

  private findEntry(payload: RoutedPayload): SubscriptionEntry | undefined {
    if (typeof payload.channel !== 'string') return undefined;
    return this.subscriptions.get(
      `${payload.channel}|${payload.assetId ?? payload.pair ?? ''}|${payload.interval ?? ''}`,
    );
  }

  private emitToMatches(
    channel: RealtimeChannel,
    payload: RoutedPayload,
    dataMessage: boolean,
  ): void {
    for (const entry of this.subscriptions.values()) {
      if (entry.spec.channel !== channel) continue;
      if (channel === 'fx_rate' && payload.pair !== entry.spec.pair) continue;
      if (payload.assetId && entry.spec.assetId !== payload.assetId) continue;
      if (
        dataMessage &&
        entry.spec.interval &&
        payload.interval &&
        entry.spec.interval !== payload.interval
      ) {
        continue;
      }
      if (
        !dataMessage &&
        payload.interval &&
        entry.spec.interval &&
        entry.spec.interval !== payload.interval
      ) {
        continue;
      }
      this.recordSubscriptionError(entry, payload);
      this.emitToEntry(entry, { kind: 'message', payload });
    }
  }

  private snapshotFor(entry: SubscriptionEntry): RealtimeRuntimeSnapshot {
    return {
      socket: this.getRuntimeSnapshot(),
      subscription: {
        ...entry.runtime,
        subscriptionSent: entry.sent,
        subscriptionAcked: entry.acked,
      },
    };
  }

  private emitEntryRuntime(entry: SubscriptionEntry): void {
    this.emitToEntry(entry, {
      kind: 'runtime',
      runtime: this.snapshotFor(entry),
    });
  }

  private emitRuntime(): void {
    for (const entry of this.subscriptions.values())
      this.emitEntryRuntime(entry);
  }

  private recordSubscriptionError(
    entry: SubscriptionEntry,
    payload: RoutedPayload,
  ): void {
    if (payload.type !== 'subscription_error' && payload.type !== 'error')
      return;
    if (payload.assetId && payload.assetId !== entry.spec.assetId) return;
    if (payload.interval && payload.interval !== entry.spec.interval) return;
    if (payload.pair && payload.pair !== entry.spec.pair) return;
    entry.runtime.subscriptionError = true;
    entry.runtime.lastSubscriptionErrorCode =
      safeRuntimeCode(payload.code) ?? 'not_observed';
    entry.runtime.lastSubscriptionErrorAt = Date.now();
    entry.runtime.lastSubscriptionErrorScope = payload.channel
      ? 'subscription'
      : 'unscoped_control';
    this.emitEntryRuntime(entry);
  }

  private emitToListener(
    listener: RealtimeSubscriptionListener,
    event: RealtimeSubscriptionEvent,
  ): void {
    try {
      listener(event);
    } catch {
      // One listener throwing must not break routing to the others.
    }
  }

  private emitToEntry(
    entry: SubscriptionEntry,
    event: RealtimeSubscriptionEvent,
  ): void {
    for (const listener of entry.listeners)
      this.emitToListener(listener, event);
  }

  private sendSubscription(
    entry: SubscriptionEntry,
    type: 'subscribe' | 'unsubscribe',
  ): void {
    if (!this.socket) return;
    try {
      this.socket.send(
        JSON.stringify({
          type,
          channel: entry.spec.channel,
          ...(entry.spec.channel === 'fx_rate'
            ? { pair: entry.spec.pair }
            : { assetId: entry.spec.assetId }),
          ...(entry.spec.interval ? { interval: entry.spec.interval } : {}),
        }),
      );
      entry.sent = type === 'subscribe';
      if (type === 'unsubscribe') entry.acked = false;
      else {
        entry.runtime.subscriptionSentAt = Date.now();
        entry.runtime.subscriptionError = false;
        this.emitEntryRuntime(entry);
      }
    } catch {
      // Best-effort; a reconnect re-sends active subscriptions.
    }
  }

  private failAuth(
    source: NonNullable<SocketRuntime['authFailureSource']>,
  ): void {
    this.authFailed = true;
    this.clearReconnectTimer();
    this.runtime.authFailureSource = source;
    this.setStatus(
      'auth_failed',
      source === 'close_1008' ? 'auth_failed_close' : 'auth_failed_control',
    );
  }

  private scheduleReconnect(): void {
    if (this.authFailed || this.subscriptions.size === 0) return;
    if (this.reconnectTimer) return;
    const delay =
      this.reconnectDelaysMs[
        Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
      ];
    this.reconnectAttempt += 1;
    this.runtime.nextReconnectDelayMs = delay;
    this.runtime.reconnectScheduledAt = Date.now();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.runtime.nextReconnectDelayMs = null;
      this.setStatus('reconnecting', 'reconnect_started');
      void this.connect();
    }, delay);
    this.emitRuntime();
  }

  private detachSocket(): void {
    if (!this.socket) return;
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
    this.socket = null;
    for (const entry of this.subscriptions.values()) {
      entry.sent = false;
      entry.acked = false;
    }
  }

  private teardown(): void {
    this.clearReconnectTimer();
    this.connectSequence += 1;
    const socket = this.socket;
    this.detachSocket();
    if (socket) {
      try {
        socket.close(1000, 'no subscribers');
      } catch {
        // Already closed.
      }
    }
    if (socket) this.runtime.lastDisconnectedAt = Date.now();
    this.status = 'idle';
    this.recordTransition('no_subscribers_teardown');
    this.reconnectAttempt = 0;
    this.hasConnectedBefore = false;
    this.authFailed = false;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.runtime.nextReconnectDelayMs = null;
  }

  private recordTransition(reason: TransportTransitionReason): void {
    this.runtime.lastTransitionReason = reason;
    this.runtime.lastTransitionAt = Date.now();
  }

  private setStatus(
    status: RealtimeSocketStatus,
    reason: TransportTransitionReason,
  ): void {
    this.status = status;
    this.recordTransition(reason);
    for (const entry of this.subscriptions.values()) {
      this.emitToEntry(entry, { kind: 'status', status });
    }
    this.emitRuntime();
  }
}

// The app-wide singleton wiring (default WebSocket + token storage) lives in
// sharedRealtimeSocket.ts so this module stays free of React Native imports
// and runs under Node's type-stripping test runner.
