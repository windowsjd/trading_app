import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { WebSocket as WsWebSocket } from 'ws';
import { TiingoAssetMapService } from './tiingo-asset-map.service';
import { TiingoConfigService, toTiingoTicker } from './tiingo.config';
import { TiingoMarketDataStore } from './tiingo-market-data.store';
import {
  parseTiingoWsMessage,
  type TiingoWsChannelKind,
} from './tiingo.parser';

export const TIINGO_SOCKET_FACTORY = Symbol('TIINGO_SOCKET_FACTORY');

export type TiingoSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
};

export type TiingoSocketFactory = (url: string) => TiingoSocket;

export function defaultTiingoSocketFactory(url: string): TiingoSocket {
  return new WsWebSocket(url, {
    handshakeTimeout: 10_000,
    maxPayload: 1_048_576,
  }) as unknown as TiingoSocket;
}

export type TiingoStreamState =
  | 'disabled'
  | 'idle'
  | 'connecting'
  | 'subscribing'
  | 'subscribed'
  | 'reconnecting'
  | 'auth_failed'
  | 'stopped';

export type TiingoStreamChannelStatus = {
  channel: TiingoWsChannelKind;
  thresholdLevel: 6 | 4;
  state: TiingoStreamState;
  tickers: string[];
  connectedAt: string | null;
  subscribedAt: string | null;
  disconnectedAt: string | null;
  lastMessageAt: string | null;
  lastHeartbeatAt: string | null;
  lastDataAt: string | null;
  reconnectCount: number;
  consecutiveFailures: number;
  nextReconnectAt: string | null;
  lastCloseCode: number | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  counters: {
    frames: number;
    heartbeats: number;
    subscribeAcks: number;
    dataMessages: number;
    accepted: number;
    duplicates: number;
    outOfOrder: number;
    foreignTickers: number;
    parseErrors: number;
    ignored: number;
    errorMessages: number;
  };
};

type ChannelContext = {
  kind: TiingoWsChannelKind;
  level: 6 | 4;
  socket: TiingoSocket | null;
  generation: number;
  attempt: number;
  subscriptionId: number | null;
  lastActivityMs: number;
  reconnectTimer: NodeJS.Timeout | null;
  handshakeTimer: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
  status: TiingoStreamChannelStatus;
};

const SOCKET_OPEN = 1;
const WATCHDOG_INTERVAL_MS = 5_000;
const TARGET_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Tiingo consolidated equity WebSocket (`wss://api.tiingo.com/equity/intraday`).
 *
 * One connection per thresholdLevel: 6 = reference price, 4 = liquidity
 * estimate. The documentation shows one subscription (one thresholdLevel) per
 * connection, so the two are not merged into one socket. Each connection
 * subscribes only the mapped allow-listed tickers; a tick for any other
 * ticker is counted and dropped.
 *
 * A HeartBeat proves the socket is alive, never that prices are fresh:
 * `lastHeartbeatAt` and `lastDataAt` are tracked separately.
 */
@Injectable()
export class TiingoStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TiingoStreamService.name);
  private readonly channels: Record<TiingoWsChannelKind, ChannelContext> = {
    reference: createContext('reference', 6),
    liquidity: createContext('liquidity', 4),
  };
  private readonly socketFactory: TiingoSocketFactory;
  private running = false;
  private tickers: string[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly configService: TiingoConfigService,
    private readonly assetMap: TiingoAssetMapService,
    private readonly store: TiingoMarketDataStore,
    @Optional()
    @Inject(TIINGO_SOCKET_FACTORY)
    socketFactory?: TiingoSocketFactory,
  ) {
    this.socketFactory = socketFactory ?? defaultTiingoSocketFactory;
  }

  onModuleInit(): void {
    void this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    const config = this.configService.getConfig();
    if (!config.enabled || !config.streamEnabled) {
      for (const context of Object.values(this.channels))
        context.status.state = 'disabled';
      return;
    }
    if (this.running) return;
    this.running = true;
    if (!config.liquidityStreamEnabled)
      this.channels.liquidity.status.state = 'disabled';
    await this.refreshTargets();
    this.refreshTimer = setInterval(() => {
      void this.refreshTargets();
    }, TARGET_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const context of Object.values(this.channels)) {
      this.teardown(context, true);
      if (context.status.state !== 'disabled') context.status.state = 'stopped';
    }
    await this.refreshing?.catch(() => undefined);
  }

  /** Re-reads the asset map; a changed ticker set reconnects each channel. */
  refreshTargets(): Promise<void> {
    this.refreshing ??= this.applyTargets().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  getStatus(): Record<TiingoWsChannelKind, TiingoStreamChannelStatus> {
    return {
      reference: snapshotStatus(this.channels.reference.status),
      liquidity: snapshotStatus(this.channels.liquidity.status),
    };
  }

  private async applyTargets(): Promise<void> {
    if (!this.running) return;
    const mapping = await this.assetMap.getMapping();
    if (!this.running) return;
    const next = mapping.targets.map((target) => target.symbol).sort();
    const changed =
      next.length !== this.tickers.length ||
      next.some((symbol, index) => symbol !== this.tickers[index]);
    this.tickers = next;
    const config = this.configService.getConfig();
    for (const context of Object.values(this.channels)) {
      if (context.kind === 'liquidity' && !config.liquidityStreamEnabled)
        continue;
      if (next.length === 0) {
        this.teardown(context, true);
        context.status.state = 'idle';
        context.status.tickers = [];
        this.recordError(context, 'TIINGO_NO_MAPPED_ASSETS');
        continue;
      }
      if (changed || context.status.state === 'idle') this.connect(context);
    }
  }

  private connect(context: ChannelContext): void {
    if (!this.running) return;
    this.teardown(context, true);
    const generation = ++context.generation;
    const config = this.configService.getConfig();
    context.subscriptionId = null;
    context.status.state = 'connecting';
    context.status.tickers = [...this.tickers];
    let socket: TiingoSocket;
    try {
      socket = this.socketFactory(config.wsUrl);
    } catch {
      this.fail(context, 'TIINGO_WS_CONNECT_FAILED');
      return;
    }
    context.socket = socket;
    context.lastActivityMs = Date.now();
    const current = () =>
      this.running &&
      context.generation === generation &&
      context.socket === socket;
    // The handshake timer covers both the TCP/TLS open and the subscribe ack.
    context.handshakeTimer = setTimeout(() => {
      if (!current()) return;
      this.recordError(
        context,
        context.status.state === 'connecting'
          ? 'TIINGO_WS_CONNECT_TIMEOUT'
          : 'TIINGO_WS_SUBSCRIBE_TIMEOUT',
      );
      closeQuietly(socket, 4002, 'handshake timeout');
    }, config.wsSubscribeTimeoutMs * 2);
    context.handshakeTimer.unref?.();

    socket.on('open', () => {
      if (!current()) return;
      context.lastActivityMs = Date.now();
      context.status.connectedAt = new Date().toISOString();
      context.status.state = 'subscribing';
      try {
        socket.send(
          JSON.stringify({
            eventName: 'subscribe',
            authorization: config.token,
            eventData: {
              thresholdLevel: context.level,
              tickers: this.tickers.map((symbol) => toTiingoTicker(symbol)),
            },
          }),
        );
      } catch {
        this.recordError(context, 'TIINGO_WS_SEND_FAILED');
        closeQuietly(socket, 4002, 'subscribe failed');
      }
    });
    socket.on('message', (data: unknown) => {
      if (!current()) return;
      this.handleFrame(context, socket, data);
    });
    socket.on('error', () => {
      if (!current()) return;
      // `ws` follows an error with close; reconnect is scheduled there.
      this.recordError(context, 'TIINGO_WS_ERROR');
    });
    socket.on('close', (code?: number) => {
      if (context.generation !== generation) return;
      context.socket = null;
      context.status.disconnectedAt = new Date().toISOString();
      context.status.lastCloseCode = typeof code === 'number' ? code : null;
      this.clearTimers(context);
      if (!this.running) {
        context.status.state = 'stopped';
        return;
      }
      if (context.status.state === 'auth_failed') {
        this.scheduleReconnect(context, true);
        return;
      }
      if (context.status.state === 'subscribed')
        this.recordError(context, 'TIINGO_WS_CLOSED');
      this.scheduleReconnect(context, false);
    });
    context.watchdog = setInterval(() => {
      if (!current()) return;
      if (Date.now() - context.lastActivityMs > config.wsHeartbeatTimeoutMs) {
        this.recordError(context, 'TIINGO_WS_HEARTBEAT_TIMEOUT');
        closeQuietly(socket, 4000, 'heartbeat timeout');
      }
    }, WATCHDOG_INTERVAL_MS);
    context.watchdog.unref?.();
  }

  private handleFrame(
    context: ChannelContext,
    socket: TiingoSocket,
    data: unknown,
  ): void {
    const receivedAt = new Date();
    context.lastActivityMs = receivedAt.getTime();
    context.status.lastMessageAt = receivedAt.toISOString();
    context.status.counters.frames += 1;
    const text = frameText(data);
    if (text === null) {
      context.status.counters.parseErrors += 1;
      return;
    }
    let message: ReturnType<typeof parseTiingoWsMessage>;
    try {
      message = parseTiingoWsMessage(text, context.kind);
    } catch {
      context.status.counters.parseErrors += 1;
      return;
    }
    switch (message.kind) {
      case 'heartbeat':
        context.status.counters.heartbeats += 1;
        context.status.lastHeartbeatAt = receivedAt.toISOString();
        return;
      case 'subscribed':
        context.status.counters.subscribeAcks += 1;
        if (message.subscriptionId !== null)
          context.subscriptionId = message.subscriptionId;
        if (context.status.state !== 'subscribed') {
          context.status.state = 'subscribed';
          context.status.subscribedAt = receivedAt.toISOString();
          context.attempt = 0;
          context.status.consecutiveFailures = 0;
          context.status.nextReconnectAt = null;
          if (context.handshakeTimer) clearTimeout(context.handshakeTimer);
          context.handshakeTimer = null;
        }
        return;
      case 'error': {
        context.status.counters.errorMessages += 1;
        const auth =
          message.responseCode === 401 || message.responseCode === 403;
        if (auth) {
          context.status.state = 'auth_failed';
          this.recordError(context, 'TIINGO_WS_AUTH_FAILED');
        } else {
          this.recordError(
            context,
            context.status.state === 'subscribed'
              ? 'TIINGO_WS_ERROR_MESSAGE'
              : 'TIINGO_WS_SUBSCRIPTION_REJECTED',
          );
        }
        closeQuietly(socket, 4001, auth ? 'auth failed' : 'provider error');
        return;
      }
      case 'ignored':
        context.status.counters.ignored += 1;
        return;
      case 'invalid':
        context.status.counters.parseErrors += 1;
        return;
      case 'reference':
      case 'liquidity': {
        context.status.counters.dataMessages += 1;
        context.status.lastDataAt = receivedAt.toISOString();
        if (!this.tickers.includes(message.symbol)) {
          context.status.counters.foreignTickers += 1;
          return;
        }
        const result =
          message.kind === 'reference'
            ? this.store.acceptReference({
                symbol: message.symbol,
                price: message.price,
                timestamp: message.timestamp,
                capturedAt: receivedAt,
                origin: 'ws',
              })
            : this.store.acceptLiquidity({
                symbol: message.symbol,
                fields: message.liquidity,
                timestamp: message.timestamp,
                capturedAt: receivedAt,
                origin: 'ws',
              });
        if (result === 'accepted') context.status.counters.accepted += 1;
        else if (result === 'duplicate')
          context.status.counters.duplicates += 1;
        else context.status.counters.outOfOrder += 1;
        return;
      }
    }
  }

  private scheduleReconnect(context: ChannelContext, authFailure: boolean) {
    if (!this.running) return;
    const config = this.configService.getConfig();
    const minMs = Math.min(config.wsReconnectMinMs, config.wsReconnectMaxMs);
    const maxMs = Math.max(config.wsReconnectMinMs, config.wsReconnectMaxMs);
    const exponential = Math.min(
      maxMs,
      minMs * 2 ** Math.min(context.attempt, 10),
    );
    const jitter = Math.floor(exponential * 0.2 * Math.random());
    // A rejected token does not improve by retrying fast.
    const delayMs = authFailure ? maxMs : Math.min(maxMs, exponential + jitter);
    context.attempt += 1;
    context.status.consecutiveFailures += 1;
    context.status.reconnectCount += 1;
    context.status.nextReconnectAt = new Date(
      Date.now() + delayMs,
    ).toISOString();
    if (!authFailure) context.status.state = 'reconnecting';
    context.reconnectTimer = setTimeout(() => {
      context.reconnectTimer = null;
      this.connect(context);
    }, delayMs);
    context.reconnectTimer.unref?.();
  }

  private fail(context: ChannelContext, code: string): void {
    this.recordError(context, code);
    context.socket = null;
    this.clearTimers(context);
    this.scheduleReconnect(context, false);
  }

  /** Invalidates the current socket; optionally unsubscribes first. */
  private teardown(context: ChannelContext, unsubscribe: boolean): void {
    context.generation += 1;
    this.clearTimers(context);
    if (context.reconnectTimer) clearTimeout(context.reconnectTimer);
    context.reconnectTimer = null;
    context.status.nextReconnectAt = null;
    const socket = context.socket;
    context.socket = null;
    if (!socket) return;
    if (
      unsubscribe &&
      socket.readyState === SOCKET_OPEN &&
      context.subscriptionId !== null
    ) {
      try {
        socket.send(
          JSON.stringify({
            eventName: 'unsubscribe',
            authorization: this.configService.getConfig().token,
            eventData: {
              subscriptionId: context.subscriptionId,
              tickers: context.status.tickers.map((symbol) =>
                toTiingoTicker(symbol),
              ),
            },
          }),
        );
      } catch {
        // Closing below releases the subscription server-side anyway.
      }
    }
    context.subscriptionId = null;
    closeQuietly(socket, 1000, 'tiingo stream shutdown');
    socket.removeAllListeners?.('message');
  }

  private clearTimers(context: ChannelContext): void {
    if (context.handshakeTimer) clearTimeout(context.handshakeTimer);
    if (context.watchdog) clearInterval(context.watchdog);
    context.handshakeTimer = null;
    context.watchdog = null;
  }

  private recordError(context: ChannelContext, code: string): void {
    const changed = context.status.lastErrorCode !== code;
    context.status.lastErrorCode = code;
    context.status.lastErrorAt = new Date().toISOString();
    if (changed)
      this.logger.warn(
        `Tiingo ${context.kind} stream status changed to ${code}.`,
      );
  }
}

function createContext(
  kind: TiingoWsChannelKind,
  level: 6 | 4,
): ChannelContext {
  return {
    kind,
    level,
    socket: null,
    generation: 0,
    attempt: 0,
    subscriptionId: null,
    lastActivityMs: 0,
    reconnectTimer: null,
    handshakeTimer: null,
    watchdog: null,
    status: {
      channel: kind,
      thresholdLevel: level,
      state: 'stopped',
      tickers: [],
      connectedAt: null,
      subscribedAt: null,
      disconnectedAt: null,
      lastMessageAt: null,
      lastHeartbeatAt: null,
      lastDataAt: null,
      reconnectCount: 0,
      consecutiveFailures: 0,
      nextReconnectAt: null,
      lastCloseCode: null,
      lastErrorCode: null,
      lastErrorAt: null,
      counters: {
        frames: 0,
        heartbeats: 0,
        subscribeAcks: 0,
        dataMessages: 0,
        accepted: 0,
        duplicates: 0,
        outOfOrder: 0,
        foreignTickers: 0,
        parseErrors: 0,
        ignored: 0,
        errorMessages: 0,
      },
    },
  };
}

function snapshotStatus(
  status: TiingoStreamChannelStatus,
): TiingoStreamChannelStatus {
  return {
    ...status,
    tickers: [...status.tickers],
    counters: { ...status.counters },
  };
}

function closeQuietly(socket: TiingoSocket, code: number, reason: string) {
  try {
    socket.close(code, reason);
  } catch {
    // Already closing/closed.
  }
}

function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part)))
    return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}
