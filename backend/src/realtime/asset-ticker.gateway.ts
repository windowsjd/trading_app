import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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

type AccessTokenPayload = {
  sub?: unknown;
};

type ClientState = {
  userId: string;
  subscriptions: Map<string, string | null>;
};

type SubscriptionMessage = {
  type?: unknown;
  channel?: unknown;
  assetId?: unknown;
};

type RealtimePriceEvent = KisRealtimePriceEvent | BinanceRealtimePriceEvent;

const TICKER_POLL_INTERVAL_MS = 3000;

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly assetsService: AssetsService,
    private readonly kisRealtimePriceEventBus: KisRealtimePriceEventBus,
    private readonly binanceRealtimePriceEventBus: BinanceRealtimePriceEventBus,
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

    if (
      message.channel !== 'asset_ticker' ||
      typeof message.assetId !== 'string' ||
      message.assetId.trim() === ''
    ) {
      this.sendInvalidSubscription(client);
      return;
    }

    const assetId = message.assetId.trim();
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

    return {
      ...ticker,
      realtime: true,
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

  private sendError(client: WebSocket, code: string, message: string) {
    this.sendJson(client, {
      type: 'error',
      code,
      message,
    });
  }

  private sendJson(client: WebSocket, payload: unknown) {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    client.send(JSON.stringify(payload));
  }

  private calculateFreshnessAgeSeconds(capturedAt: string): number {
    const capturedAtTime = Date.parse(capturedAt);
    if (Number.isNaN(capturedAtTime)) {
      return 0;
    }

    return Math.max(0, Math.floor((Date.now() - capturedAtTime) / 1000));
  }
}
