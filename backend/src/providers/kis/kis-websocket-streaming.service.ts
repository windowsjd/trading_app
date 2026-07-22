import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { readLiveCandleConfig } from '../../assets/live-candle.config';
import {
  ProviderConfigService,
  type ProviderConfig,
} from '../provider-config.service';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import { NormalizedProviderTradeEventBus } from '../normalized-provider-trade-event-bus.service';
import { ProviderTradeRouteRegistry } from '../provider-trade-route.registry';
import { KisAuthClient } from './kis-auth.client';
import {
  KisRealtimePriceCacheService,
  type KisRealtimePriceCacheEntry,
} from './kis-realtime-price-cache.service';
import { KisRealtimePriceEventBus } from './kis-realtime-price-event-bus.service';
import {
  closeKisSocket,
  KIS_WEB_SOCKET_OPEN,
  kisSocketEventToText,
  resolveKisNativeWebSocketConstructor,
  waitForKisSocketOpen,
  type KisNativeWebSocket,
  type KisNativeWebSocketConstructor,
} from './kis-websocket.client';
import { KisWebSocketIngestionService } from './kis-websocket.ingestion.service';
import {
  buildKisWebSocketSubscriptionRequest,
  type KisWebSocketSubscriptionRequest,
} from './kis-websocket.subscription';
import { parseKisWebSocketMessage } from './kis-websocket.trade-parser';
import type {
  KisSnapshotIngestionSummary,
  KisWebSocketParsedMessage,
  KisWebSocketSubscriptionSkip,
  KisWebSocketSubscriptionTarget,
} from './kis-websocket.types';

export type KisWebSocketStreamingState =
  | 'disabled'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'connected_no_ticks'
  | 'reconnecting'
  | 'stopped'
  | 'failed';

export type KisWebSocketStreamingStatus = {
  enabled: boolean;
  running: boolean;
  state: KisWebSocketStreamingState;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  subscribedSymbolCount: number;
  subscriptionSkips: KisWebSocketSubscriptionSkip[];
  lastStartedAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastMessageAt: string | null;
  lastTradeAt: string | null;
  lastHeartbeatAt: string | null;
  lastSnapshotAt: string | null;
  reconnectCount: number;
  nextReconnectAt: string | null;
  nextReconnectDelayMs: number | null;
  receivedFrames: number;
  receivedTrades: number;
  acknowledged: number;
  created: number;
  skipped: number;
  failed: number;
  latestPriceCount: number;
  eventListenerCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

const KIS_STREAMING_CONNECT_TIMEOUT_MS = 10_000;

@Injectable()
export class KisWebSocketStreamingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(KisWebSocketStreamingService.name);
  private socket: KisNativeWebSocket | null = null;
  private approvalKey: string | null = null;
  private targets: readonly KisWebSocketSubscriptionTarget[] = [];
  private subscriptionSkips: KisWebSocketSubscriptionSkip[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pendingMessages = new Set<Promise<void>>();
  private tradeProcessingTail: Promise<void> = Promise.resolve();
  private reconnectAttempt = 0;
  private stopping = false;

  private status: KisWebSocketStreamingStatus = {
    enabled: false,
    running: false,
    state: 'stopped',
    connected: false,
    connecting: false,
    reconnecting: false,
    subscribedSymbolCount: 0,
    subscriptionSkips: [],
    lastStartedAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastMessageAt: null,
    lastTradeAt: null,
    lastHeartbeatAt: null,
    lastSnapshotAt: null,
    reconnectCount: 0,
    nextReconnectAt: null,
    nextReconnectDelayMs: null,
    receivedFrames: 0,
    receivedTrades: 0,
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
    private readonly authClient: KisAuthClient,
    private readonly ingestionService: KisWebSocketIngestionService,
    private readonly latestPriceCache: KisRealtimePriceCacheService,
    private readonly realtimePriceEventBus: KisRealtimePriceEventBus,
    @Optional()
    private readonly normalizedTradeEventBus?: NormalizedProviderTradeEventBus,
    @Optional()
    private readonly tradeRoutes?: ProviderTradeRouteRegistry,
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

    const liveCandles = readLiveCandleConfig();
    // Exactly one canonical KIS connection per process. The live-candle
    // supervisor owns it whenever live candles are on; this legacy service
    // then neither connects nor publishes normalized trades, so no duplicate
    // socket and no duplicate exact-trade event can exist.
    if (
      (liveCandles.enabled && liveCandles.kisEnabled) ||
      this.tradeRoutes?.claimProvider('kis', 'legacy_streaming') === false
    ) {
      this.status.enabled = false;
      this.status.running = false;
      this.status.state = 'disabled';
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
    this.status.reconnecting = false;
    this.status.connecting = false;
    this.status.nextReconnectAt = null;
    this.status.nextReconnectDelayMs = null;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();

    const socket = this.socket;
    if (socket && socket.readyState === KIS_WEB_SOCKET_OPEN) {
      const closePromise = waitForSocketClose(socket);
      this.sendUnsubscribeRequests(socket);
      socket.close(1000, 'streaming shutdown');
      await Promise.race([closePromise, sleep(1000)]);
    }

    await Promise.allSettled([...this.pendingMessages]);
    this.socket = null;
    this.approvalKey = null;
    this.targets = [];
    this.tradeRoutes?.releaseProvider('kis', 'legacy_streaming');
    this.markDisconnected();
    this.status.state = this.status.enabled ? 'stopped' : 'disabled';
  }

  getStatus(): KisWebSocketStreamingStatus {
    const latestPriceCount = this.latestPriceCache.getAll().length;
    const eventListenerCount = this.realtimePriceEventBus.listenerCount();
    const state = this.resolveState();

    return {
      ...this.status,
      state,
      latestPriceCount,
      eventListenerCount,
      subscriptionSkips: [...this.subscriptionSkips],
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
    this.status.connecting = true;
    this.status.reconnecting = false;
    this.status.connected = false;
    this.status.nextReconnectAt = null;
    this.status.nextReconnectDelayMs = null;

    let config: ProviderConfig;
    try {
      config = this.configService.getConfig();
      this.status.enabled = config.kis.wsStreamingEnabled;
      if (!config.kis.wsStreamingEnabled) {
        this.status.running = false;
        this.status.connecting = false;
        this.status.state = 'disabled';
        return;
      }

      const gate = assertKisStreamingGate(config);
      if (gate) {
        this.recordError(gate, gate);
        this.scheduleReconnect(config);
        return;
      }

      const websocketConstructor = resolveKisNativeWebSocketConstructor();
      if (!websocketConstructor) {
        this.recordError(
          'WEBSOCKET_CLIENT_UNAVAILABLE',
          'Native WebSocket client is unavailable in this Node runtime.',
        );
        this.scheduleReconnect(config);
        return;
      }

      const approval =
        await this.authClient.requestConfiguredWebSocketApprovalKey();
      if (approval.state === 'skipped') {
        this.recordError(approval.reason, approval.reason);
        this.scheduleReconnect(config);
        return;
      }

      const subscriptions =
        await this.ingestionService.buildSubscriptionTargets();
      this.subscriptionSkips = [...subscriptions.skipped];
      if (subscriptions.targets.length === 0) {
        this.recordError(
          'KIS_WATCHLIST_EMPTY',
          'KIS WebSocket watchlist has no subscribable symbols.',
        );
        this.scheduleReconnect(config);
        return;
      }

      await this.openSocket({
        config,
        websocketConstructor,
        approvalKey: approval.response.approvalKey,
        targets: subscriptions.targets,
      });
    } catch (error) {
      const details = errorDetails(error);
      this.recordError(details.code, details.message);
      if (configFromUnknown(error)) {
        this.logger.warn(
          `KIS WebSocket streaming configuration failed: ${details.code}`,
        );
      } else {
        this.logger.warn(`KIS WebSocket streaming failed: ${details.code}`);
      }

      try {
        config = this.configService.getConfig();
        this.status.enabled = config.kis.wsStreamingEnabled;
        if (config.kis.wsStreamingEnabled) {
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
    websocketConstructor: KisNativeWebSocketConstructor;
    approvalKey: string;
    targets: readonly KisWebSocketSubscriptionTarget[];
  }): Promise<void> {
    const socket = new input.websocketConstructor(
      input.config.kis.wsBaseUrl ?? '',
    );
    this.socket = socket;
    this.approvalKey = input.approvalKey;
    this.targets = [...input.targets];

    await waitForKisSocketOpen(
      socket,
      Math.min(
        input.config.kis.wsStreamingHeartbeatTimeoutMs,
        KIS_STREAMING_CONNECT_TIMEOUT_MS,
      ),
    );

    if (!this.status.running || this.stopping || this.socket !== socket) {
      closeKisSocket(socket);
      return;
    }

    socket.addEventListener('message', (event) => {
      this.handleSocketMessage({
        event,
        approvalKey: input.approvalKey,
      });
    });
    socket.addEventListener('error', () => {
      this.recordError(
        'KIS_WEBSOCKET_ERROR',
        'KIS WebSocket emitted an error.',
      );
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.markDisconnected();
      this.clearHeartbeatTimer();
      if (this.status.running && !this.stopping) {
        this.recordError(
          'KIS_WEBSOCKET_CLOSED',
          'KIS WebSocket connection closed.',
        );
        this.scheduleReconnect(input.config);
      }
    });

    const subscribeRequests = input.targets.map((target) =>
      buildKisWebSocketSubscriptionRequest({
        approvalKey: input.approvalKey,
        custType: input.config.kis.wsCustType,
        action: 'subscribe',
        trId: target.trId,
        trKey: target.trKey,
      }),
    );

    for (const request of subscribeRequests) {
      socket.send(JSON.stringify(request));
    }

    const now = new Date().toISOString();
    this.status.connected = true;
    this.status.connecting = false;
    this.status.reconnecting = false;
    this.status.lastConnectedAt = now;
    this.status.subscribedSymbolCount = subscribeRequests.length;
    this.status.lastErrorCode = null;
    this.status.lastErrorMessage = null;
    this.reconnectAttempt = 0;
    this.startHeartbeat(input.config.kis.wsStreamingHeartbeatTimeoutMs);
    this.logger.log(
      `KIS WebSocket streaming connected with ${subscribeRequests.length} subscriptions.`,
    );
  }

  private handleSocketMessage(input: {
    event: unknown;
    approvalKey: string;
  }): void {
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

  private async processSocketMessage(input: {
    event: unknown;
    approvalKey: string;
  }): Promise<void> {
    const text = kisSocketEventToText(input.event);
    if (text === null) {
      this.status.failed += 1;
      this.recordError(
        'KIS_WEBSOCKET_UNREADABLE_MESSAGE',
        'KIS WebSocket message payload could not be read.',
      );
      return;
    }

    const receivedAt = new Date();
    this.status.receivedFrames += 1;
    this.status.lastMessageAt = receivedAt.toISOString();

    const parsed = parseKisWebSocketMessage({
      frame: text,
      receivedAt,
    });
    if (parsed.state === 'heartbeat') {
      // Echo the official PINGPONG frame back verbatim (KIS protocol) and
      // record control-frame liveness separately from trade freshness.
      this.status.lastHeartbeatAt = receivedAt.toISOString();
      try {
        this.socket?.send(parsed.rawFrame);
      } catch {
        // A best-effort echo failure surfaces via the liveness timeout.
      }
      return;
    }
    const processParsedMessage = async (): Promise<void> => {
      const cacheEntries = this.updateLatestCache(parsed);
      const result = await this.ingestionService.ingestParsedMessage(parsed, {
        dryRun: false,
        requestedBy: 'kis-websocket-streaming',
        secrets: [input.approvalKey],
      });

      this.status.acknowledged += result.acknowledged;
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

      this.publishLatestPriceEvents(cacheEntries, result.snapshots);
      if (parsed.state === 'trades') {
        parsed.trades.forEach((trade, index) => {
          const assetId = result.snapshots[index]?.assetId;
          if (!assetId) return;
          const providerEventAt =
            trade.exchangeTimestamp ??
            trade.sourceTimestamp ??
            trade.receivedAt;
          // Never a duplicate publisher: if the live-candle supervisor owns
          // the KIS route, that connection is the only exact-trade source.
          if (this.tradeRoutes?.isOwnedBy('kis', 'legacy_streaming') === false)
            return;
          this.normalizedTradeEventBus?.publish({
            provider: 'kis',
            providerEventId: trade.eventId,
            providerSequence: trade.sequence,
            providerConnectionId: null,
            assetId,
            symbol: trade.symbol,
            providerSymbol: trade.providerSymbol,
            price: trade.price,
            currencyCode:
              trade.kind === 'domestic_krx_realtime_trade' ? 'KRW' : 'USD',
            providerEventAt: providerEventAt.toISOString(),
            receivedAt: trade.receivedAt.toISOString(),
            sourceName:
              trade.kind === 'domestic_krx_realtime_trade'
                ? 'kis_krx_realtime_trade'
                : 'kis_us_delayed_trade',
            marketSessionCode: trade.marketSessionCode,
            eventType: 'trade',
          });
        });
      }

      if (parsed.state === 'failed') {
        this.recordError(parsed.reason, parsed.message);
        if (parsed.reason === 'KIS_SUBSCRIPTION_ACK_FAILED') {
          this.socket?.close(1011, 'subscription ack failed');
        }
      }
    };

    if (parsed.state === 'trades') {
      await this.enqueueTradeProcessing(processParsedMessage);
    } else {
      await processParsedMessage();
    }
  }

  private enqueueTradeProcessing(task: () => Promise<void>): Promise<void> {
    const processing = this.tradeProcessingTail.then(task);
    this.tradeProcessingTail = processing.catch(() => undefined);
    return processing;
  }

  private updateLatestCache(
    parsed: KisWebSocketParsedMessage,
  ): KisRealtimePriceCacheEntry[] {
    if (parsed.state !== 'trades') {
      return [];
    }

    this.status.receivedTrades += parsed.trades.length;
    this.status.lastTradeAt = parsed.receivedAt.toISOString();
    return parsed.trades.map((trade) =>
      this.latestPriceCache.updateFromTrade(trade),
    );
  }

  private publishLatestPriceEvents(
    cacheEntries: readonly KisRealtimePriceCacheEntry[],
    snapshots: readonly KisSnapshotIngestionSummary[],
  ): void {
    cacheEntries.forEach((entry, index) => {
      const summary = snapshots[index];
      this.realtimePriceEventBus.publish({
        type: 'kis_realtime_price',
        price: entry,
        assetId: summary?.assetId ?? null,
        snapshotState: summary?.state ?? null,
        snapshotReason: summary?.reason,
      });
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
        'KIS_WEBSOCKET_HEARTBEAT_TIMEOUT',
        'No KIS WebSocket message was received within the heartbeat timeout.',
      );
      this.socket?.close(4000, 'heartbeat timeout');
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private scheduleReconnect(config: ProviderConfig): void {
    const minMs = Math.min(
      config.kis.wsStreamingReconnectMinMs,
      config.kis.wsStreamingReconnectMaxMs,
    );
    const maxMs = Math.max(
      config.kis.wsStreamingReconnectMinMs,
      config.kis.wsStreamingReconnectMaxMs,
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
      `KIS WebSocket streaming reconnect scheduled in ${delayMs}ms after ${
        this.status.lastErrorCode ?? 'UNKNOWN'
      }.`,
    );
  }

  private sendUnsubscribeRequests(socket: KisNativeWebSocket): void {
    const approvalKey = this.approvalKey;
    if (!approvalKey || this.targets.length === 0) {
      return;
    }

    let config: ProviderConfig;
    try {
      config = this.configService.getConfig();
    } catch {
      return;
    }

    for (const request of buildUnsubscribeRequests({
      approvalKey,
      custType: config.kis.wsCustType,
      targets: this.targets,
    })) {
      try {
        socket.send(JSON.stringify(request));
      } catch {
        return;
      }
    }
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
      this.logger.warn(`KIS WebSocket streaming status changed to ${code}.`);
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

  private resolveState(): KisWebSocketStreamingState {
    if (!this.status.enabled) {
      if (this.status.running && this.status.lastErrorCode) {
        return 'failed';
      }
      return 'disabled';
    }

    if (this.status.connected) {
      return this.status.lastTradeAt ? 'connected' : 'connected_no_ticks';
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

function assertKisStreamingGate(config: ProviderConfig): string | null {
  if (!config.common.providerIngestionEnabled) {
    return 'PROVIDER_INGESTION_DISABLED';
  }

  if (!config.kis.enabled) {
    return 'PROVIDER_DISABLED';
  }

  if (!config.kis.restBaseUrl) {
    return 'KIS_REST_BASE_URL_MISSING';
  }

  if (!config.kis.wsBaseUrl) {
    return 'KIS_WS_BASE_URL_MISSING';
  }

  return null;
}

function buildUnsubscribeRequests(input: {
  approvalKey: string;
  custType: string;
  targets: readonly KisWebSocketSubscriptionTarget[];
}): KisWebSocketSubscriptionRequest[] {
  return input.targets.map((target) =>
    buildKisWebSocketSubscriptionRequest({
      approvalKey: input.approvalKey,
      custType: input.custType,
      action: 'unsubscribe',
      trId: target.trId,
      trKey: target.trKey,
    }),
  );
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (
    error instanceof ProviderConfigError ||
    error instanceof ProviderHttpError
  ) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: error.name || 'KIS_WEBSOCKET_STREAMING_ERROR',
      message: error.message,
    };
  }

  return {
    code: 'KIS_WEBSOCKET_STREAMING_ERROR',
    message: String(error),
  };
}

function configFromUnknown(error: unknown): boolean {
  return error instanceof ProviderConfigError;
}

function waitForSocketClose(socket: KisNativeWebSocket): Promise<void> {
  return new Promise((resolve) => {
    const onClose = () => {
      socket.removeEventListener('close', onClose);
      resolve();
    };
    socket.addEventListener('close', onClose);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms) as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timeout.unref?.();
  });
}
