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

export type RealtimeChannel = 'asset_ticker' | 'asset_candle';

export interface RealtimeSubscriptionSpec {
  channel: RealtimeChannel;
  assetId: string;
  interval?: string;
}

export type RealtimeSocketStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failed';

export type RealtimeSubscriptionEvent =
  | { kind: 'status'; status: RealtimeSocketStatus }
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
};

function subscriptionKey(spec: RealtimeSubscriptionSpec): string {
  return `${spec.channel}|${spec.assetId}|${spec.interval ?? ''}`;
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
      entry = { spec, listeners: new Set(), sent: false, acked: false };
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
    listener({ kind: 'status', status: this.status });
    if (this.status === 'connected') {
      if (entry.acked) {
        listener({
          kind: 'message',
          payload: {
            type: 'subscribed',
            channel: entry.spec.channel,
            assetId: entry.spec.assetId,
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
    this.reconnectAttempt = 0;
    if (this.socket) {
      const socket = this.socket;
      this.detachSocket();
      try {
        socket.close(1000, 'token refresh');
      } catch {
        // Already closed.
      }
    }
    this.clearReconnectTimer();
    if (this.subscriptions.size > 0) void this.connect();
  }

  getStatus(): RealtimeSocketStatus {
    return this.status;
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
  }

  private ensureConnected(): void {
    if (this.socket || this.reconnectTimer || this.authFailed) return;
    if (this.subscriptions.size === 0) return;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.socket || this.authFailed) return;
    const sequence = (this.connectSequence += 1);
    this.setStatus(this.hasConnectedBefore ? 'reconnecting' : 'connecting');

    let token: string | null = null;
    try {
      token = await this.deps.getToken();
    } catch {
      token = null;
    }
    // The manager may have been torn down or superseded while awaiting.
    if (sequence !== this.connectSequence || this.subscriptions.size === 0) {
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = this.deps.createSocket(appendToken(this.wsUrl, token));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      const wasReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.reconnectAttempt = 0;
      this.setStatus('connected');
      for (const entry of this.subscriptions.values()) {
        entry.acked = false;
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
      this.detachSocket();
      if (event?.code === 1008) {
        this.failAuth();
        return;
      }
      this.setStatus('disconnected');
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
      this.failAuth();
      try {
        socket?.close();
      } catch {
        // Already closed.
      }
      return;
    }

    if (payload.type === 'subscribed' && typeof payload.channel === 'string') {
      const entry = this.findEntry(payload);
      if (entry) entry.acked = true;
    }

    if (payload.type === 'asset_ticker') {
      this.emitToMatches('asset_ticker', payload, true);
      return;
    }
    if (payload.type === 'asset_candle') {
      this.emitToMatches('asset_candle', payload, true);
      return;
    }
    if (payload.channel === 'asset_ticker' || payload.channel === 'asset_candle') {
      this.emitToMatches(payload.channel, payload, false);
      return;
    }
    // Channel-less control/error messages cannot be attributed: let every
    // subscription apply its own relevance rules (matches previous per-hook
    // behavior for e.g. INVALID_SUBSCRIPTION).
    for (const entry of this.subscriptions.values()) {
      this.emitToEntry(entry, { kind: 'message', payload });
    }
  }

  private findEntry(payload: RoutedPayload): SubscriptionEntry | undefined {
    if (typeof payload.channel !== 'string') return undefined;
    return this.subscriptions.get(
      `${payload.channel}|${payload.assetId ?? ''}|${payload.interval ?? ''}`,
    );
  }

  private emitToMatches(
    channel: RealtimeChannel,
    payload: RoutedPayload,
    dataMessage: boolean,
  ): void {
    for (const entry of this.subscriptions.values()) {
      if (entry.spec.channel !== channel) continue;
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
      this.emitToEntry(entry, { kind: 'message', payload });
    }
  }

  private emitToEntry(
    entry: SubscriptionEntry,
    event: RealtimeSubscriptionEvent,
  ): void {
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch {
        // One listener throwing must not break routing to the others.
      }
    }
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
          assetId: entry.spec.assetId,
          ...(entry.spec.interval ? { interval: entry.spec.interval } : {}),
        }),
      );
      entry.sent = type === 'subscribe';
      if (type === 'unsubscribe') entry.acked = false;
    } catch {
      // Best-effort; a reconnect re-sends active subscriptions.
    }
  }

  private failAuth(): void {
    this.authFailed = true;
    this.clearReconnectTimer();
    this.setStatus('auth_failed');
  }

  private scheduleReconnect(): void {
    if (this.authFailed || this.subscriptions.size === 0) return;
    if (this.reconnectTimer) return;
    const delay =
      this.reconnectDelaysMs[
        Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
      ];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.setStatus('reconnecting');
      void this.connect();
    }, delay);
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
    this.status = 'idle';
    this.reconnectAttempt = 0;
    this.hasConnectedBefore = false;
    this.authFailed = false;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: RealtimeSocketStatus): void {
    this.status = status;
    for (const entry of this.subscriptions.values()) {
      this.emitToEntry(entry, { kind: 'status', status });
    }
  }
}

// The app-wide singleton wiring (default WebSocket + token storage) lives in
// sharedRealtimeSocket.ts so this module stays free of React Native imports
// and runs under Node's type-stripping test runner.
