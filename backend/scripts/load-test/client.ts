import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Credentials, Manifest } from './manifest';
import { endpointKey, Histogram, Metrics } from './metrics';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export class AppClient {
  accessToken = '';
  refreshToken = '';
  refreshCount = 0;
  onRefresh?: () => void;
  private refreshing?: Promise<void>;
  private cache = new Map<string, { at: number; value: any }>();
  private inFlight = new Map<string, Promise<any>>();
  constructor(
    readonly m: Manifest,
    readonly credentials: Credentials,
    readonly email: string,
    readonly metrics: Metrics,
  ) {}
  async login() {
    const d = await this.request(
      'POST',
      '/auth/login',
      { email: this.email, password: this.credentials.userPassword },
      false,
    );
    this.tokens(d);
    this.metrics.count('auth.login');
  }
  private tokens(data: any) {
    this.accessToken = data.tokens.accessToken;
    this.refreshToken = data.tokens.refreshToken;
  }
  async refresh() {
    this.refreshing ??= (async () => {
      const d = await this.request(
        'POST',
        '/auth/refresh',
        { refreshToken: this.refreshToken },
        false,
      );
      this.tokens(d);
      this.refreshCount++;
      this.metrics.count('auth.refresh');
      this.onRefresh?.();
    })().finally(() => {
      this.refreshing = undefined;
    });
    await this.refreshing;
  }
  invalidate() {
    this.cache.clear();
  }
  async get(path: string, staleMs = 5000, force = false): Promise<any> {
    const hit = this.cache.get(path);
    if (!force && hit && performance.now() - hit.at < staleMs) {
      this.metrics.count('query.cacheHit');
      return hit.value;
    }
    const pending = this.inFlight.get(path);
    if (pending) {
      this.metrics.count('query.inFlightDedup');
      return pending;
    }
    const p = (async () => {
      // Same one retry as default React Query reads, no mutation retry.
      for (let attempt = 0; ; attempt++) {
        try {
          const value = await this.request('GET', path);
          this.cache.set(path, { at: performance.now(), value });
          return value;
        } catch (e) {
          if (
            attempt ||
            !(e instanceof ApiFailure) ||
            (e.status > 0 && e.status < 500)
          )
            throw e;
          this.metrics.count('query.retry');
          await delay(1000);
        }
      }
    })().finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, p);
    return p;
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
    refreshed = false,
  ): Promise<any> {
    const endpoint = `${method} ${endpointKey(path)}`;
    const phase = this.metrics.phase;
    const begin = performance.now();
    this.metrics.count(`http.request.${endpoint}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let status = 0;
    try {
      const response = await fetch(`${this.m.target.apiOrigin}/api/v1${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(auth && this.accessToken
            ? { authorization: `Bearer ${this.accessToken}` }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = response.status;
      const text = await response.text();
      this.metrics.count('http.receivedBytes', Buffer.byteLength(text));
      const data = JSON.parse(text);
      this.metrics.count(`http.status.${status}.${endpoint}`);
      if (status === 401 && auth && !refreshed && this.refreshToken) {
        this.metrics.count('auth.expired401');
        await this.refresh();
        return await this.request(method, path, body, auth, true);
      }
      if (!response.ok || data.success !== true) {
        const code =
          typeof data.error?.code === 'string'
            ? data.error.code
            : `HTTP_${status}`;
        this.metrics.count(`http.failed.${endpoint}`);
        this.metrics.failure(code, endpoint);
        throw new ApiFailure(status, code);
      }
      // Exact account ownership is also checked in the final full audit.
      const accountId = /^\/trading-accounts\/([^/]+)/.exec(path)?.[1];
      if (
        accountId &&
        data.data?.tradingAccountId &&
        data.data.tradingAccountId !== accountId
      ) {
        this.metrics.failure('ACCOUNT_SCOPE_VIOLATION', endpoint);
        throw new ApiFailure(500, 'ACCOUNT_SCOPE_VIOLATION');
      }
      return data.data;
    } catch (e) {
      if (e instanceof ApiFailure) throw e;
      const code = controller.signal.aborted
        ? 'HTTP_TIMEOUT'
        : status
          ? 'INVALID_HTTP_ENVELOPE'
          : 'HTTP_TRANSPORT_FAILURE';
      this.metrics.count(`http.failed.${endpoint}`);
      this.metrics.failure(code, endpoint);
      throw new ApiFailure(status, code);
    } finally {
      clearTimeout(timer);
      (this.metrics.histograms[`${phase}:http.${endpoint}`] ??=
        new Histogram()).add(performance.now() - begin);
    }
  }
}
export type Subscription = {
  channel: 'asset_ticker' | 'asset_candle' | 'asset_order_book' | 'fx_rate';
  assetId?: string;
  interval?: string;
  pair?: string;
};
const key = (s: Subscription) =>
  `${s.channel}|${s.assetId ?? s.pair}|${s.interval ?? ''}`;
export class AppSocket {
  socket?: WebSocket;
  subscriptions = new Map<string, Subscription>();
  acked = new Set<string>();
  connected = false;
  stopped = false;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private connectionAt = 0;
  private disconnectedAt = 0;
  private connectionSequence = 0;
  private connecting?: Promise<void>;
  fxInvalidated = false;
  candleRestored = false;
  clockOffsetMs = 0;
  constructor(
    readonly client: AppClient,
    readonly metrics: Metrics,
  ) {
    client.onRefresh = () => {
      void this.reconnectFresh().catch(() =>
        this.metrics.failure('WS_REFRESH_RECONNECT_FAILED'),
      );
    };
  }
  setSubscriptions(specs: Subscription[]) {
    const wanted = new Map(specs.map((s) => [key(s), s]));
    for (const [k, s] of this.subscriptions)
      if (!wanted.has(k)) {
        this.send('unsubscribe', s);
        this.acked.delete(k);
      }
    for (const [k, s] of wanted)
      if (!this.subscriptions.has(k)) this.send('subscribe', s);
    this.subscriptions = wanted;
    if (!this.socket && !this.stopped && wanted.size)
      void this.connect().catch(() =>
        this.metrics.failure('WS_CONNECT_FAILED'),
      );
  }
  private send(type: string, s: Subscription) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type, ...s }));
      this.metrics.count(`ws.${type}`);
    }
  }
  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const sequence = ++this.connectionSequence;
    this.connecting = new Promise<void>((resolve, reject) => {
      const url = new URL('/api/v1/ws', this.client.m.target.apiOrigin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('token', this.client.accessToken);
      const socket = new WebSocket(url, {
        handshakeTimeout: 10000,
        followRedirects: false,
      });
      this.socket = socket;
      socket.on('open', () => {
        if (this.stopped || sequence !== this.connectionSequence) {
          socket.close();
          return;
        }
        this.connected = true;
        this.connectionAt = performance.now();
        this.metrics.count('ws.connect');
        if (this.disconnectedAt)
          this.metrics.time(
            'ws.recovery',
            this.connectionAt - this.disconnectedAt,
          );
        this.attempt = 0;
        this.acked.clear();
        // The gateway installs its listener after asynchronous DB auth. Local
        // loopback has no WAN/UI delay; model 100ms user think before the
        // first dispatch. This is recorded, not a gateway/auth bypass.
        setTimeout(() => {
          if (sequence === this.connectionSequence && !this.stopped)
            for (const s of this.subscriptions.values())
              this.send('subscribe', s);
        }, 100);
        if (this.disconnectedAt) {
          this.candleRestored = true;
          this.metrics.count('ws.restored');
        }
        resolve();
      });
      socket.on('message', (raw) => {
        if (sequence !== this.connectionSequence) return;
        this.metrics.count(
          'ws.receivedBytes',
          raw instanceof Buffer
            ? raw.length
            : Buffer.byteLength(raw.toString()),
        );
        let p: any;
        try {
          p = JSON.parse(raw.toString());
        } catch {
          this.metrics.failure('INVALID_WS_JSON');
          return;
        }
        if (p.type === 'subscribed') {
          this.acked.add(key(p));
          this.metrics.count(`ws.ack.${p.channel}`);
          return;
        }
        if (p.type === 'unsubscribed') {
          this.metrics.count('ws.unsubscribeAck');
          return;
        }
        if (p.type === 'error' || p.type === 'subscription_error') {
          this.metrics.failure(p.code ?? 'WS_SUBSCRIPTION_ERROR');
          return;
        }
        const channel =
          p.channel ??
          (p.type === 'ticker'
            ? 'asset_ticker'
            : p.type === 'candle'
              ? 'asset_candle'
              : p.type === 'order_book'
                ? 'asset_order_book'
                : p.type);
        this.metrics.count(`ws.message.${channel}`);
        const captured =
          p.price?.priceCapturedAt ??
          p.priceCapturedAt ??
          p.book?.capturedAt ??
          p.capturedAt ??
          p.receivedAt ??
          p.sourceUpdatedAt;
        if (typeof captured === 'string') {
          const ms = Date.parse(captured);
          if (Number.isFinite(ms)) {
            const age = Date.now() - this.clockOffsetMs - ms;
            if (age < -50) this.metrics.failure('WS_CLOCK_INVALID');
            else
              this.metrics.time(
                `ws.${p.assetPriceSnapshotId ? 'snapshotFallbackLatency' : 'ingressLatency'}.${channel}`,
                Math.max(0, age),
              );
          }
        } else if (
          ![
            'candle_stale',
            'pong',
            'fx_rate_updated',
            'resync_required',
          ].includes(p.type)
        )
          this.metrics.count(`ws.latencyUnavailable.${channel}`);
        if (p.type === 'resync_required') this.candleRestored = true;
        if (channel === 'fx_rate') this.fxInvalidated = true;
      });
      socket.on('error', () => {
        this.metrics.count('ws.transportError');
        reject(new Error('WS_TRANSPORT_FAILURE'));
      });
      socket.on('close', (code) => {
        if (sequence !== this.connectionSequence) return;
        this.connected = false;
        this.socket = undefined;
        this.acked.clear();
        this.disconnectedAt = performance.now();
        if (this.connectionAt)
          this.metrics.time(
            'ws.connectionDuration',
            this.disconnectedAt - this.connectionAt,
          );
        this.metrics.count(`ws.disconnect.${code}`);
        reject(new Error('WS_DISCONNECTED'));
        if (this.stopped || code === 1008) return; // same terminal auth behavior as app manager
        const wait = [1000, 2000, 5000, 10000, 30000][
          Math.min(this.attempt++, 4)
        ];
        this.timer = setTimeout(() => {
          this.metrics.count('ws.reconnect');
          void this.connect().catch(() =>
            this.metrics.count('ws.reconnectFailed'),
          );
        }, wait);
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  async ready(timeoutMs = 10000) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      if (
        this.connected &&
        this.subscriptions.size > 0 &&
        [...this.subscriptions.keys()].every((k) => this.acked.has(k))
      )
        return;
      await delay(20);
    }
    throw new Error('WS_AUTHENTICATED_ACK_TIMEOUT');
  }
  async reconnectFresh() {
    if (this.stopped || this.subscriptions.size === 0) return;
    ++this.connectionSequence;
    this.socket?.terminate();
    this.socket = undefined;
    this.connected = false;
    this.acked.clear();
    this.connecting = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.disconnectedAt = performance.now();
    this.metrics.count('ws.tokenRefreshReconnect');
    await this.connect();
  }
  backlogBytes() {
    return (this.socket as any)?._socket?.readableLength ?? 0;
  }
  close() {
    this.stopped = true;
    ++this.connectionSequence;
    if (this.timer) clearTimeout(this.timer);
    if (this.connected && this.connectionAt)
      this.metrics.time(
        'ws.connectionDuration',
        performance.now() - this.connectionAt,
      );
    for (const s of this.subscriptions.values()) this.send('unsubscribe', s);
    this.socket?.close(1000, 'load test completed');
    this.connected = false;
    this.acked.clear();
  }
}
