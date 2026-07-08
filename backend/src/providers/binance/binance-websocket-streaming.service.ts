import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WebSocket as WsWebSocket } from 'ws';
import {
  ProviderConfigService,
  type ProviderConfig,
} from '../provider-config.service';
import { ProviderConfigError } from '../provider.types';
import {
  BinanceRealtimePriceCacheService,
  type BinanceRealtimePriceCacheEntry,
} from './binance-realtime-price-cache.service';
import { BinanceRealtimePriceEventBus } from './binance-realtime-price-event-bus.service';
import { BINANCE_SPOT_WS_TICKER_SOURCE_NAME } from './binance-price.ingestion.service';
import { BinanceWebSocketIngestionService } from './binance-websocket.ingestion.service';
import { parseBinanceWebSocketMessage } from './binance-websocket.parser';
import type {
  BinanceWebSocketParsedMessage,
  BinanceWebSocketTickerSummary,
} from './binance-websocket.types';

export type BinanceWebSocketStreamingState =
  | 'disabled'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'connected_no_tickers'
  | 'reconnecting'
  | 'stopped'
  | 'failed';

export type BinanceWebSocketStreamingStatus = {
  enabled: boolean;
  running: boolean;
  state: BinanceWebSocketStreamingState;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  subscribedSymbolCount: number;
  subscribedStreams: string[];
  lastStartedAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastMessageAt: string | null;
  lastTickerAt: string | null;
  lastSnapshotAt: string | null;
  reconnectCount: number;
  nextReconnectAt: string | null;
  nextReconnectDelayMs: number | null;
  receivedFrames: number;
  receivedTickers: number;
  acknowledged: number;
  created: number;
  skipped: number;
  failed: number;
  latestPriceCount: number;
  eventListenerCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

type NativeWebSocketConstructor = new (url: string) => NativeWebSocket;

type NativeWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  on?(type: string, listener: (data?: Buffer) => void): void;
  pong?(data?: Buffer): void;
};

const WEB_SOCKET_OPEN = 1;
const BINANCE_STREAM_LIMIT = 1024;
const BINANCE_STREAM_CONNECT_TIMEOUT_MS = 10_000;
const BINANCE_SCHEDULED_RECONNECT_MS = 23 * 60 * 60 * 1000 + 55 * 60 * 1000;

@Injectable()
export class BinanceWebSocketStreamingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BinanceWebSocketStreamingService.name);
  private socket: NativeWebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private maxConnectionTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pendingMessages = new Set<Promise<void>>();
  private streamNames: string[] = [];
  private reconnectAttempt = 0;
  private stopping = false;

  private status: BinanceWebSocketStreamingStatus = {
    enabled: false,
    running: false,
    state: 'stopped',
    connected: false,
    connecting: false,
    reconnecting: false,
    subscribedSymbolCount: 0,
    subscribedStreams: [],
    lastStartedAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastMessageAt: null,
    lastTickerAt: null,
    lastSnapshotAt: null,
    reconnectCount: 0,
    nextReconnectAt: null,
    nextReconnectDelayMs: null,
    receivedFrames: 0,
    receivedTickers: 0,
    acknowledged: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    latestPriceCount: 0,
    eventListenerCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
  };

  constructor(
    private readonly configService: ProviderConfigService,
    private readonly ingestionService: BinanceWebSocketIngestionService,
    private readonly latestPriceCache: BinanceRealtimePriceCacheService,
    private readonly realtimePriceEventBus: BinanceRealtimePriceEventBus,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.status.running || this.connectPromise) {
      return;
    }

    this.stopping = false;
    this.status.running = true;
    this.status.lastStartedAt = new Date().toISOString();
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.status.running = false;
    this.status.connecting = false;
    this.status.reconnecting = false;
    this.status.nextReconnectAt = null;
    this.status.nextReconnectDelayMs = null;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearMaxConnectionTimer();

    const socket = this.socket;
    if (socket && socket.readyState === WEB_SOCKET_OPEN) {
      const closePromise = waitForSocketClose(socket);
      this.sendUnsubscribe(socket);
      socket.close(1000, 'streaming shutdown');
      await Promise.race([closePromise, sleep(1000)]);
    }

    await Promise.allSettled([...this.pendingMessages]);
    this.socket = null;
    this.markDisconnected();
    this.status.state = this.status.enabled ? 'stopped' : 'disabled';
  }

  getStatus(): BinanceWebSocketStreamingStatus {
    return {
      ...this.status,
      state: this.resolveState(),
      subscribedStreams: [...this.streamNames],
      latestPriceCount: this.latestPriceCache.getAll().length,
      eventListenerCount: this.realtimePriceEventBus.listenerCount(),
    };
  }

  private async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectOnce().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private async connectOnce(): Promise<void> {
    if (!this.status.running || this.stopping) {
      return;
    }

    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearMaxConnectionTimer();
    this.status.connecting = true;
    this.status.reconnecting = false;
    this.status.connected = false;
    this.status.nextReconnectAt = null;
    this.status.nextReconnectDelayMs = null;

    let config: ProviderConfig;
    try {
      config = this.configService.getConfig();
      this.status.enabled = config.binance.wsStreamingEnabled;
      if (!config.binance.wsStreamingEnabled) {
        this.status.running = false;
        this.status.connecting = false;
        this.status.state = 'disabled';
        return;
      }

      const gate = assertBinanceStreamingGate(config);
      if (gate) {
        this.recordError(gate, gate);
        this.scheduleReconnect(config);
        return;
      }

      const streamNames = buildTickerStreamNames(config.binance.symbols);
      if (streamNames.length === 0) {
        this.recordError(
          'BINANCE_STREAMS_EMPTY',
          'Binance WebSocket stream list is empty.',
        );
        this.scheduleReconnect(config);
        return;
      }
      if (streamNames.length > BINANCE_STREAM_LIMIT) {
        this.recordError(
          'BINANCE_STREAM_LIMIT_EXCEEDED',
          'Binance WebSocket supports at most 1024 streams per connection.',
        );
        this.scheduleReconnect(config);
        return;
      }

      await this.openSocket({
        config,
        websocketConstructor: resolveNativeWebSocketConstructor(),
        streamNames,
      });
    } catch (error) {
      const details = errorDetails(error);
      this.recordError(details.code, details.message);
      this.logger.warn(`Binance WebSocket streaming failed: ${details.code}`);
      try {
        config = this.configService.getConfig();
        this.status.enabled = config.binance.wsStreamingEnabled;
        if (config.binance.wsStreamingEnabled) {
          this.scheduleReconnect(config);
        } else {
          this.status.running = false;
          this.status.connecting = false;
        }
      } catch {
        this.scheduleReconnectWithDefaults();
      }
    }
  }

  private async openSocket(input: {
    config: ProviderConfig;
    websocketConstructor: NativeWebSocketConstructor;
    streamNames: readonly string[];
  }): Promise<void> {
    const socket = new input.websocketConstructor(
      buildBinanceStreamUrl(input.config.binance.wsMarketDataBaseUrl),
    );
    this.socket = socket;
    this.streamNames = [...input.streamNames];

    await waitForSocketOpen(
      socket,
      Math.min(
        input.config.binance.wsStreamingHeartbeatTimeoutMs,
        BINANCE_STREAM_CONNECT_TIMEOUT_MS,
      ),
    );

    if (!this.status.running || this.stopping || this.socket !== socket) {
      closeSocket(socket);
      return;
    }

    this.attachPingPong(socket);
    socket.addEventListener('message', (event) => {
      this.handleSocketMessage({ event });
    });
    socket.addEventListener('error', () => {
      this.recordError(
        'BINANCE_WEBSOCKET_ERROR',
        'Binance WebSocket emitted an error.',
      );
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.markDisconnected();
      this.clearHeartbeatTimer();
      this.clearMaxConnectionTimer();
      if (this.status.running && !this.stopping) {
        if (!isExpectedReconnectCloseReason(this.status.lastErrorCode)) {
          this.recordError(
            'BINANCE_WEBSOCKET_CLOSED',
            'Binance WebSocket connection closed.',
          );
        }
        this.scheduleReconnect(input.config);
      }
    });

    this.sendSubscribe(socket, input.streamNames);

    const now = new Date().toISOString();
    this.status.connected = true;
    this.status.connecting = false;
    this.status.reconnecting = false;
    this.status.lastConnectedAt = now;
    this.status.subscribedSymbolCount = input.streamNames.length;
    this.status.lastErrorCode = null;
    this.status.lastErrorMessage = null;
    this.reconnectAttempt = 0;
    this.startHeartbeat(input.config.binance.wsStreamingHeartbeatTimeoutMs);
    this.startMaxConnectionTimer(socket);
    this.logger.log(
      `Binance WebSocket streaming connected with ${input.streamNames.length} ticker streams.`,
    );
  }

  private handleSocketMessage(input: { event: unknown }): void {
    const promise = this.processSocketMessage(input)
      .catch((error: unknown) => {
        const details = errorDetails(error);
        this.status.failed += 1;
        this.recordError(details.code, details.message);
      })
      .finally(() => {
        this.pendingMessages.delete(promise);
      });
    this.pendingMessages.add(promise);
  }

  private async processSocketMessage(input: { event: unknown }): Promise<void> {
    const text = socketEventToText(input.event);
    if (text === null) {
      this.status.failed += 1;
      this.recordError(
        'BINANCE_WEBSOCKET_UNREADABLE_MESSAGE',
        'Binance WebSocket message payload could not be read.',
      );
      return;
    }

    const receivedAt = new Date();
    this.status.receivedFrames += 1;
    this.status.lastMessageAt = receivedAt.toISOString();

    const parsed = parseBinanceWebSocketMessage({
      frame: text,
      receivedAt,
    });

    if (parsed.state === 'ack') {
      this.status.acknowledged += 1;
      return;
    }

    if (parsed.state === 'server_shutdown') {
      this.recordError(
        'BINANCE_SERVER_SHUTDOWN',
        'Binance sent serverShutdown and requested reconnect.',
      );
      this.socket?.close(1012, 'server shutdown');
      return;
    }

    const cacheEntry = this.updateLatestCache(parsed);
    const result = await this.ingestionService.ingestParsedMessage(parsed, {
      dryRun: false,
      requestedBy: 'binance-websocket-streaming',
    });

    this.status.created += result.created;
    this.status.skipped += result.skipped;
    this.status.failed += result.failed;
    if (result.created > 0) {
      this.status.lastSnapshotAt = receivedAt.toISOString();
    }
    if (result.errorCode) {
      this.recordError(
        result.errorCode,
        result.errorMessage ?? result.errorCode,
      );
    }

    if (cacheEntry) {
      this.publishLatestPriceEvent(cacheEntry, result.tickers[0]);
    }

    if (parsed.state === 'failed') {
      this.recordError(parsed.reason, parsed.message);
    }
  }

  private updateLatestCache(
    parsed: BinanceWebSocketParsedMessage,
  ): BinanceRealtimePriceCacheEntry | null {
    if (parsed.state !== 'ticker') {
      return null;
    }

    this.status.receivedTickers += 1;
    this.status.lastTickerAt = parsed.receivedAt.toISOString();
    return this.latestPriceCache.updateFromTicker({
      ticker: parsed.ticker,
      sourceName: BINANCE_SPOT_WS_TICKER_SOURCE_NAME,
    });
  }

  private publishLatestPriceEvent(
    cacheEntry: BinanceRealtimePriceCacheEntry,
    summary: BinanceWebSocketTickerSummary | undefined,
  ): void {
    this.realtimePriceEventBus.publish({
      type: 'binance_realtime_price',
      price: cacheEntry,
      assetId: summary?.assetId ?? null,
      snapshotState: summary?.state ?? null,
      snapshotReason: summary?.reason,
    });
  }

  private sendSubscribe(
    socket: NativeWebSocket,
    streamNames: readonly string[],
  ): void {
    socket.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: streamNames,
        id: 1,
      }),
    );
  }

  private sendUnsubscribe(socket: NativeWebSocket): void {
    if (this.streamNames.length === 0) {
      return;
    }

    try {
      socket.send(
        JSON.stringify({
          method: 'UNSUBSCRIBE',
          params: this.streamNames,
          id: 2,
        }),
      );
    } catch {
      return;
    }
  }

  private attachPingPong(socket: NativeWebSocket): void {
    socket.on?.('ping', (data?: Buffer) => {
      socket.pong?.(data);
    });
  }

  private startHeartbeat(timeoutMs: number): void {
    this.clearHeartbeatTimer();
    const intervalMs = Math.max(1000, Math.min(timeoutMs, 5000));
    this.heartbeatTimer = setInterval(() => {
      const lastSeenAt =
        this.status.lastMessageAt ??
        this.status.lastConnectedAt ??
        new Date().toISOString();
      const ageMs = Date.now() - Date.parse(lastSeenAt);
      if (ageMs <= timeoutMs) {
        return;
      }

      this.recordError(
        'BINANCE_WEBSOCKET_HEARTBEAT_TIMEOUT',
        'No Binance WebSocket message was received within the heartbeat timeout.',
      );
      this.socket?.close(4000, 'heartbeat timeout');
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private startMaxConnectionTimer(socket: NativeWebSocket): void {
    this.clearMaxConnectionTimer();
    this.maxConnectionTimer = setTimeout(() => {
      if (this.socket !== socket || !this.status.running || this.stopping) {
        return;
      }

      this.recordError(
        'BINANCE_WEBSOCKET_SCHEDULED_RECONNECT',
        'Binance WebSocket scheduled reconnect before the 24-hour connection limit.',
      );
      socket.close(4001, 'scheduled reconnect');
    }, BINANCE_SCHEDULED_RECONNECT_MS);
    this.maxConnectionTimer.unref?.();
  }

  private scheduleReconnect(config: ProviderConfig): void {
    const minMs = Math.min(
      config.binance.wsStreamingReconnectMinMs,
      config.binance.wsStreamingReconnectMaxMs,
    );
    const maxMs = Math.max(
      config.binance.wsStreamingReconnectMinMs,
      config.binance.wsStreamingReconnectMaxMs,
    );
    const delayMs = Math.min(maxMs, minMs * 2 ** this.reconnectAttempt);
    this.scheduleReconnectIn(delayMs);
  }

  private scheduleReconnectWithDefaults(): void {
    this.scheduleReconnectIn(30_000);
  }

  private scheduleReconnectIn(delayMs: number): void {
    if (!this.status.running || this.stopping) {
      return;
    }

    this.clearReconnectTimer();
    this.status.connected = false;
    this.status.connecting = false;
    this.status.reconnecting = true;
    this.status.reconnectCount += 1;
    this.status.nextReconnectDelayMs = delayMs;
    this.status.nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
    this.logger.warn(
      `Binance WebSocket streaming reconnect scheduled in ${delayMs}ms after ${
        this.status.lastErrorCode ?? 'UNKNOWN'
      }.`,
    );
  }

  private markDisconnected(): void {
    if (this.status.connected) {
      this.status.lastDisconnectedAt = new Date().toISOString();
    }
    this.status.connected = false;
    this.status.connecting = false;
    this.status.subscribedSymbolCount = 0;
  }

  private recordError(code: string, message: string): void {
    const changed = this.status.lastErrorCode !== code;
    this.status.lastErrorCode = code;
    this.status.lastErrorMessage = message;
    if (changed) {
      this.logger.warn(
        `Binance WebSocket streaming status changed to ${code}.`,
      );
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearMaxConnectionTimer(): void {
    if (this.maxConnectionTimer) {
      clearTimeout(this.maxConnectionTimer);
      this.maxConnectionTimer = null;
    }
  }

  private resolveState(): BinanceWebSocketStreamingState {
    if (!this.status.enabled) {
      if (this.status.running && this.status.lastErrorCode) {
        return 'failed';
      }
      return 'disabled';
    }

    if (this.status.connected) {
      return this.status.lastTickerAt ? 'connected' : 'connected_no_tickers';
    }

    if (this.status.reconnecting) {
      return 'reconnecting';
    }

    if (this.status.connecting) {
      return 'connecting';
    }

    if (!this.status.running) {
      return 'stopped';
    }

    if (this.status.lastErrorCode) {
      return 'failed';
    }

    return 'starting';
  }
}

function assertBinanceStreamingGate(config: ProviderConfig): string | null {
  if (!config.common.providerIngestionEnabled) {
    return 'PROVIDER_INGESTION_DISABLED';
  }

  if (!config.binance.enabled) {
    return 'PROVIDER_DISABLED';
  }

  if (!config.binance.wsMarketDataBaseUrl) {
    return 'BINANCE_WS_MARKET_DATA_BASE_URL_MISSING';
  }

  return null;
}

function buildTickerStreamNames(symbols: readonly string[]): string[] {
  const seen = new Set<string>();
  const streams: string[] = [];
  for (const symbol of symbols) {
    const normalized = symbol.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    streams.push(`${normalized}@ticker`);
  }

  return streams;
}

function buildBinanceStreamUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, '');
  if (/\/(?:ws|stream)(?:\?|$)/u.test(base)) {
    return base;
  }

  return `${base}/ws`;
}

function resolveNativeWebSocketConstructor(): NativeWebSocketConstructor {
  const constructor = (
    globalThis as {
      WebSocket?: NativeWebSocketConstructor;
    }
  ).WebSocket;
  return constructor ?? (WsWebSocket as unknown as NativeWebSocketConstructor);
}

function waitForSocketOpen(
  socket: NativeWebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === WEB_SOCKET_OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new ProviderConfigError(
          'binance',
          'BINANCE_WEBSOCKET_CONNECT_TIMEOUT',
          'Binance WebSocket connection timed out.',
        ),
      );
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(
        new ProviderConfigError(
          'binance',
          'BINANCE_WEBSOCKET_CONNECT_FAILED',
          'Binance WebSocket connection failed.',
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

function waitForSocketClose(socket: NativeWebSocket): Promise<void> {
  return new Promise((resolve) => {
    const onClose = () => {
      socket.removeEventListener('close', onClose);
      resolve();
    };
    socket.addEventListener('close', onClose);
  });
}

function closeSocket(socket: NativeWebSocket): void {
  if (socket.readyState === WEB_SOCKET_OPEN) {
    socket.close(1000, 'finished');
  }
}

function isExpectedReconnectCloseReason(code: string | null): boolean {
  return (
    code === 'BINANCE_SERVER_SHUTDOWN' ||
    code === 'BINANCE_WEBSOCKET_HEARTBEAT_TIMEOUT' ||
    code === 'BINANCE_WEBSOCKET_SCHEDULED_RECONNECT'
  );
}

function socketEventToText(event: unknown): string | null {
  const data = (event as { data?: unknown }).data;
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8',
    );
  }

  return null;
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderConfigError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: error.name || 'BINANCE_WEBSOCKET_STREAMING_ERROR',
      message: error.message,
    };
  }

  return {
    code: 'BINANCE_WEBSOCKET_STREAMING_ERROR',
    message: String(error),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms) as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timeout.unref?.();
  });
}
