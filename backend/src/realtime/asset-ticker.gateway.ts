import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer as WsServer } from 'ws';
import { UserStatus } from '../generated/prisma/client';
import { AssetsService } from '../assets/assets.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BinanceRealtimePriceEvent,
  BinanceRealtimePriceEventBus,
} from '../providers/binance/binance-realtime-price-event-bus.service';
import {
  KisRealtimePriceEvent,
  KisRealtimePriceEventBus,
} from '../providers/kis/kis-realtime-price-event-bus.service';
import {
  LIVE_CANDLE_CONFIG,
  type LiveCandleConfig,
} from '../assets/live-candle.config';
import { LiveCandleOverlayService } from '../assets/live-candle-overlay.service';
import {
  LIVE_CANDLE_INTERVALS,
  type AssetCandleSnapshotEvent,
  type LiveCandleInterval,
} from '../assets/live-candle.types';
import {
  LiveCandlePubSubService,
  type LiveCandlePubSubStatus,
} from './live-candle-pubsub.service';
import {
  ProviderPricePubSubService,
  type ProviderRealtimePriceEvent,
} from './provider-price-pubsub.service';

type AccessTokenPayload = {
  sub?: unknown;
};

type ClientState = {
  userId: string;
  subscriptions: Map<string, string | null>;
  candleSubscriptions: Map<
    string,
    { lastSequence: number; lastRevision: number }
  >;
  pendingCandles: Map<string, AssetCandleSnapshotEvent>;
};

type SubscriptionMessage = {
  type?: unknown;
  channel?: unknown;
  assetId?: unknown;
  interval?: unknown;
};

type RealtimePriceEvent =
  | KisRealtimePriceEvent
  | BinanceRealtimePriceEvent
  | ProviderRealtimePriceEvent;

const TICKER_POLL_INTERVAL_MS = 3000;
const CANDLE_BACKPRESSURE_FLUSH_MS = 100;
const DEFAULT_CANDLE_SUBSCRIPTION_LIMIT = 20;
const DEFAULT_CANDLE_BACKPRESSURE_BYTES = 1_048_576;

@Injectable()
@WebSocketGateway({
  path: '/api/v1/ws',
})
export class AssetTickerGateway
  implements
    OnGatewayConnection<WebSocket>,
    OnGatewayDisconnect<WebSocket>,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  private readonly server!: WsServer;

  private readonly clients = new Map<WebSocket, ClientState>();
  private pollTimer: NodeJS.Timeout | null = null;
  private unsubscribeKisRealtimePrices: (() => void) | null = null;
  private unsubscribeBinanceRealtimePrices: (() => void) | null = null;
  private unsubscribeLiveCandles: (() => void) | null = null;
  private unsubscribeLiveCandleStatus: (() => void) | null = null;
  private unsubscribeProviderPrices: (() => void) | null = null;
  private backpressureTimer: NodeJS.Timeout | null = null;
  private liveCandlePubSubStatus: LiveCandlePubSubStatus = 'disabled';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly assetsService: AssetsService,
    private readonly kisRealtimePriceEventBus: KisRealtimePriceEventBus,
    private readonly binanceRealtimePriceEventBus: BinanceRealtimePriceEventBus,
    @Optional() private readonly liveCandlePubSub?: LiveCandlePubSubService,
    @Optional() private readonly liveCandleOverlay?: LiveCandleOverlayService,
    @Optional()
    @Inject(LIVE_CANDLE_CONFIG)
    private readonly liveCandleConfig?: LiveCandleConfig,
    @Optional()
    private readonly providerPricePubSub?: ProviderPricePubSubService,
  ) {}

  onModuleInit() {
    this.pollTimer = setInterval(() => {
      void this.pushChangedTickers();
    }, TICKER_POLL_INTERVAL_MS);
    this.unsubscribeKisRealtimePrices = this.kisRealtimePriceEventBus.subscribe(
      (event) => this.pushRealtimePriceEvent(event),
    );
    this.unsubscribeBinanceRealtimePrices =
      this.binanceRealtimePriceEventBus.subscribe((event) =>
        this.pushRealtimePriceEvent(event),
      );
    this.unsubscribeLiveCandles =
      this.liveCandlePubSub?.subscribe((event) =>
        this.pushLiveCandleEvent(event),
      ) ?? null;
    this.unsubscribeLiveCandleStatus =
      this.liveCandlePubSub?.onStatusChange((status) =>
        this.handleLiveCandlePubSubStatus(status),
      ) ?? null;
    this.unsubscribeProviderPrices =
      this.providerPricePubSub?.subscribe((event) =>
        this.pushRealtimePriceEvent(event),
      ) ?? null;
    this.backpressureTimer = setInterval(
      () => this.flushPendingCandles(),
      CANDLE_BACKPRESSURE_FLUSH_MS,
    );
    this.backpressureTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.unsubscribeKisRealtimePrices?.();
    this.unsubscribeKisRealtimePrices = null;
    this.unsubscribeBinanceRealtimePrices?.();
    this.unsubscribeBinanceRealtimePrices = null;
    this.unsubscribeLiveCandles?.();
    this.unsubscribeLiveCandles = null;
    this.unsubscribeLiveCandleStatus?.();
    this.unsubscribeLiveCandleStatus = null;
    this.unsubscribeProviderPrices?.();
    this.unsubscribeProviderPrices = null;
    if (this.backpressureTimer) clearInterval(this.backpressureTimer);
    this.backpressureTimer = null;
  }

  async handleConnection(client: WebSocket, request: IncomingMessage) {
    const userId = await this.authenticate(request);
    if (!userId) {
      this.sendError(client, 'UNAUTHORIZED', 'Unauthorized');
      client.close(1008, 'Unauthorized');
      return;
    }

    this.clients.set(client, {
      userId,
      subscriptions: new Map(),
      candleSubscriptions: new Map(),
      pendingCandles: new Map(),
    });
    client.on('message', (data) => {
      void this.handleMessage(client, data.toString());
    });
    client.on('error', () => {
      this.clients.delete(client);
    });
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
  }

  private async handleMessage(client: WebSocket, rawMessage: string) {
    const state = this.clients.get(client);
    if (!state) {
      return;
    }

    const message = this.parseMessage(rawMessage);
    if (!message) {
      this.sendInvalidSubscription(client);
      return;
    }

    if (typeof message.assetId !== 'string' || message.assetId.trim() === '') {
      this.sendInvalidSubscription(client);
      return;
    }

    const assetId = message.assetId.trim();
    if (message.channel === 'asset_candle') {
      await this.handleCandleSubscription(client, state, message, assetId);
      return;
    }
    if (message.channel !== 'asset_ticker') {
      this.sendInvalidSubscription(client);
      return;
    }
    if (message.type === 'subscribe') {
      const ticker = await this.buildTickerMessage(assetId);
      if (!ticker) {
        this.sendInvalidSubscription(client);
        return;
      }

      state.subscriptions.set(assetId, ticker.assetPriceSnapshotId);
      this.sendJson(client, {
        type: 'subscribed',
        channel: 'asset_ticker',
        assetId,
      });
      this.sendJson(client, ticker);
      return;
    }

    if (message.type === 'unsubscribe') {
      state.subscriptions.delete(assetId);
      this.sendJson(client, {
        type: 'unsubscribed',
        channel: 'asset_ticker',
        assetId,
      });
      return;
    }

    this.sendInvalidSubscription(client);
  }

  private async handleCandleSubscription(
    client: WebSocket,
    state: ClientState,
    message: SubscriptionMessage,
    assetId: string,
  ): Promise<void> {
    if (
      typeof message.interval !== 'string' ||
      !(LIVE_CANDLE_INTERVALS as readonly string[]).includes(message.interval)
    ) {
      this.sendCandleSubscriptionError(
        client,
        assetId,
        typeof message.interval === 'string' ? message.interval : null,
        'INVALID_INTERVAL',
      );
      return;
    }
    const interval = message.interval as LiveCandleInterval;
    const key = candleSubscriptionKey(assetId, interval);
    if (message.type === 'unsubscribe') {
      state.candleSubscriptions.delete(key);
      state.pendingCandles.delete(key);
      this.sendJson(client, {
        type: 'unsubscribed',
        channel: 'asset_candle',
        assetId,
        interval,
      });
      return;
    }
    if (message.type !== 'subscribe') {
      this.sendCandleSubscriptionError(
        client,
        assetId,
        interval,
        'INVALID_SUBSCRIPTION',
      );
      return;
    }
    if (!state.candleSubscriptions.has(key)) {
      const limit =
        this.liveCandleConfig?.maxSubscriptionsPerClient ??
        DEFAULT_CANDLE_SUBSCRIPTION_LIMIT;
      if (state.candleSubscriptions.size >= limit) {
        this.sendCandleSubscriptionError(
          client,
          assetId,
          interval,
          'SUBSCRIPTION_LIMIT',
        );
        return;
      }
      const asset = await this.prisma.asset.findUnique({
        where: { id: assetId },
        select: { id: true, isActive: true },
      });
      if (!asset?.isActive) {
        this.sendCandleSubscriptionError(
          client,
          assetId,
          interval,
          'ASSET_NOT_AVAILABLE',
        );
        return;
      }
      state.candleSubscriptions.set(key, {
        lastSequence: 0,
        lastRevision: -1,
      });
    }
    this.sendJson(client, {
      type: 'subscribed',
      channel: 'asset_candle',
      assetId,
      interval,
    });
    try {
      const current = await this.liveCandleOverlay?.getCurrentSnapshot(
        assetId,
        interval,
      );
      if (current) {
        this.sendCandleSnapshot(client, state, { ...current, sequence: 0 });
      }
    } catch {
      this.sendJson(client, {
        type: 'candle_stale',
        channel: 'asset_candle',
        assetId,
        interval,
      });
    }
  }

  private parseMessage(rawMessage: string): SubscriptionMessage | null {
    try {
      const parsed = JSON.parse(rawMessage) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      return parsed as SubscriptionMessage;
    } catch {
      return null;
    }
  }

  private async pushChangedTickers() {
    const assetIds = new Set<string>();
    for (const state of this.clients.values()) {
      for (const assetId of state.subscriptions.keys()) {
        assetIds.add(assetId);
      }
    }

    for (const assetId of assetIds) {
      const ticker = await this.buildTickerMessage(assetId);
      if (!ticker) {
        continue;
      }

      for (const [client, state] of this.clients.entries()) {
        if (client.readyState !== WebSocket.OPEN) {
          this.clients.delete(client);
          continue;
        }

        const lastSnapshotId = state.subscriptions.get(assetId);
        if (lastSnapshotId === undefined) {
          continue;
        }

        if (lastSnapshotId === ticker.assetPriceSnapshotId) {
          continue;
        }

        state.subscriptions.set(assetId, ticker.assetPriceSnapshotId);
        this.sendJson(client, ticker);
      }
    }
  }

  private async pushRealtimePriceEvent(event: RealtimePriceEvent) {
    if (!event.assetId) {
      return;
    }

    const ticker = await this.buildRealtimeTickerMessage(event);
    if (!ticker) {
      return;
    }

    for (const [client, state] of this.clients.entries()) {
      if (client.readyState !== WebSocket.OPEN) {
        this.clients.delete(client);
        continue;
      }

      if (!state.subscriptions.has(event.assetId)) {
        continue;
      }

      this.sendJson(client, ticker);
      if (event.snapshotState === 'created') {
        state.subscriptions.set(
          event.assetId,
          ticker.assetPriceSnapshotId ?? null,
        );
      }
    }
  }

  private pushLiveCandleEvent(event: AssetCandleSnapshotEvent): void {
    const key = candleSubscriptionKey(event.assetId, event.interval);
    for (const [client, state] of this.clients.entries()) {
      if (client.readyState !== WebSocket.OPEN) {
        this.clients.delete(client);
        continue;
      }
      if (!state.candleSubscriptions.has(key)) continue;
      this.sendCandleSnapshot(client, state, event);
    }
  }

  private sendCandleSnapshot(
    client: WebSocket,
    state: ClientState,
    event: AssetCandleSnapshotEvent,
  ): void {
    const key = candleSubscriptionKey(event.assetId, event.interval);
    const subscription = state.candleSubscriptions.get(key);
    if (!subscription) return;
    if (
      event.sequence < subscription.lastSequence ||
      (event.sequence === subscription.lastSequence &&
        event.revision <= subscription.lastRevision)
    ) {
      return;
    }
    const maxBuffered =
      this.liveCandleConfig?.websocketBackpressureBytes ??
      DEFAULT_CANDLE_BACKPRESSURE_BYTES;
    if (client.bufferedAmount > maxBuffered) {
      const pending = state.pendingCandles.get(key);
      if (
        pending &&
        (event.sequence < pending.sequence ||
          (event.sequence === pending.sequence &&
            event.revision <= pending.revision))
      ) {
        return;
      }
      state.pendingCandles.set(key, event);
      return;
    }
    if (this.sendJson(client, event)) {
      subscription.lastSequence = Math.max(
        subscription.lastSequence,
        event.sequence,
      );
      subscription.lastRevision = Math.max(
        subscription.lastRevision,
        event.revision,
      );
      state.pendingCandles.delete(key);
    }
  }

  private flushPendingCandles(): void {
    for (const [client, state] of this.clients.entries()) {
      if (client.readyState !== WebSocket.OPEN) {
        this.clients.delete(client);
        continue;
      }
      for (const event of [...state.pendingCandles.values()]) {
        this.sendCandleSnapshot(client, state, event);
        if (client.bufferedAmount > 0) break;
      }
    }
  }

  private handleLiveCandlePubSubStatus(status: LiveCandlePubSubStatus): void {
    const previous = this.liveCandlePubSubStatus;
    this.liveCandlePubSubStatus = status;
    if (
      status === previous ||
      status === 'disabled' ||
      status === 'connecting'
    ) {
      return;
    }
    for (const [client, state] of this.clients.entries()) {
      for (const key of state.candleSubscriptions.keys()) {
        const [assetId, interval] = parseCandleSubscriptionKey(key);
        this.sendJson(client, {
          type:
            status === 'connected' && previous === 'unavailable'
              ? 'resync_required'
              : 'candle_stale',
          channel: 'asset_candle',
          assetId,
          interval,
        });
      }
    }
  }

  private async buildTickerMessage(assetId: string) {
    const selection = await this.assetsService.getAssetPriceForTicker(assetId);
    if (!selection) {
      return null;
    }

    const { asset, price } = selection;
    if (price.state === 'unavailable') {
      return {
        type: 'asset_ticker',
        assetId: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        priceLocal: null,
        priceCurrency: asset.priceCurrency,
        priceKrw: null,
        priceKrwState: 'unavailable',
        changeRate: null,
        assetPriceSnapshotId: null,
        priceCapturedAt: null,
        priceEffectiveAt: null,
        freshnessAgeSeconds: null,
        priceSource: null,
        reason: price.reason,
        message: price.message,
      };
    }

    const priceKrwAvailable = price.priceKrwState === 'available';

    return {
      type: 'asset_ticker',
      assetId: asset.id,
      symbol: asset.symbol,
      name: asset.name,
      priceLocal: price.currentPrice,
      priceCurrency: price.priceCurrency,
      priceKrw: priceKrwAvailable ? price.priceKrw : null,
      priceKrwState: price.priceKrwState,
      ...(priceKrwAvailable
        ? {}
        : {
            priceKrwReason: price.priceKrwReason,
            priceKrwMessage: price.priceKrwMessage,
          }),
      changeRate: price.changeRate,
      assetPriceSnapshotId: price.assetPriceSnapshotId,
      priceCapturedAt: price.priceCapturedAt,
      priceEffectiveAt: price.priceEffectiveAt,
      freshnessAgeSeconds: this.calculateFreshnessAgeSeconds(
        price.priceCapturedAt,
      ),
      priceSource: price.priceSource,
      ...(price.fxRateSource ? { fxRateSource: price.fxRateSource } : {}),
    };
  }

  private async buildRealtimeTickerMessage(event: RealtimePriceEvent) {
    if (!event.assetId) {
      return null;
    }

    const ticker = await this.buildTickerMessage(event.assetId);
    if (!ticker) {
      return null;
    }
    const delayed =
      event.type === 'kis_realtime_price' &&
      event.price.sourceName === 'kis_us_delayed_trade';

    return {
      ...ticker,
      realtime: !delayed,
      ...(delayed ? { delayed: true } : {}),
      snapshotState: event.snapshotState,
      ...(event.snapshotReason ? { snapshotReason: event.snapshotReason } : {}),
      priceLocal: event.price.price,
      priceCurrency: event.price.currencyCode,
      priceCapturedAt: event.price.capturedAt,
      priceEffectiveAt: event.price.effectiveAt,
      freshnessAgeSeconds: this.calculateFreshnessAgeSeconds(
        event.price.capturedAt,
      ),
      priceSource: {
        sourceType: 'provider_api',
        sourceName: event.price.sourceName,
      },
      ...('changeRate' in event.price
        ? { changeRate: event.price.changeRate }
        : {}),
    };
  }

  private async authenticate(request: IncomingMessage): Promise<string | null> {
    const token = this.extractToken(request);
    if (!token) {
      return null;
    }

    const secret = this.configService.get<string>('JWT_ACCESS_SECRET')?.trim();
    if (!secret) {
      return null;
    }

    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        token,
        { secret },
      );
      const userId =
        typeof payload.sub === 'string' && payload.sub.trim()
          ? payload.sub.trim()
          : null;
      if (!userId) {
        return null;
      }

      const user = await this.prisma.user.findUnique({
        where: {
          id: userId,
        },
        select: {
          status: true,
        },
      });

      return user?.status === UserStatus.active ? userId : null;
    } catch {
      return null;
    }
  }

  private extractToken(request: IncomingMessage): string | null {
    const host = request.headers.host ?? 'localhost';
    const url = new URL(request.url ?? '/', `http://${host}`);
    const queryToken = url.searchParams.get('token')?.trim();
    if (queryToken) {
      return queryToken;
    }

    const authorization = request.headers.authorization;
    if (Array.isArray(authorization) || !authorization) {
      return null;
    }

    const [scheme, token] = authorization.trim().split(/\s+/);
    return scheme === 'Bearer' && token ? token : null;
  }

  private sendInvalidSubscription(client: WebSocket) {
    this.sendError(
      client,
      'INVALID_SUBSCRIPTION',
      'Invalid asset_ticker subscription.',
    );
  }

  private sendCandleSubscriptionError(
    client: WebSocket,
    assetId: string,
    interval: string | null,
    code: string,
  ): void {
    this.sendJson(client, {
      type: 'subscription_error',
      channel: 'asset_candle',
      assetId,
      interval,
      code,
      message: 'Invalid asset_candle subscription.',
    });
  }

  private sendError(client: WebSocket, code: string, message: string) {
    this.sendJson(client, {
      type: 'error',
      code,
      message,
    });
  }

  private sendJson(client: WebSocket, payload: unknown): boolean {
    if (client.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      client.send(JSON.stringify(payload));
      return true;
    } catch {
      this.clients.delete(client);
      return false;
    }
  }

  private calculateFreshnessAgeSeconds(capturedAt: string): number {
    const capturedAtTime = Date.parse(capturedAt);
    if (Number.isNaN(capturedAtTime)) {
      return 0;
    }

    return Math.max(0, Math.floor((Date.now() - capturedAtTime) / 1000));
  }
}

function candleSubscriptionKey(
  assetId: string,
  interval: LiveCandleInterval,
): string {
  return `${assetId}\u0000${interval}`;
}

function parseCandleSubscriptionKey(key: string): [string, string] {
  const [assetId, interval] = key.split('\u0000');
  return [assetId, interval];
}
