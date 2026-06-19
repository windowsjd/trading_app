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
import {
  CurrencyCode,
  Prisma,
  UserStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.pollTimer = setInterval(() => {
      void this.pushChangedTickers();
    }, TICKER_POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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

  private async buildTickerMessage(assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        isActive: true,
      },
      select: {
        id: true,
        symbol: true,
        name: true,
        priceCurrency: true,
        currencyCode: true,
      },
    });

    if (!asset) {
      return null;
    }

    const priceCurrency = asset.priceCurrency ?? asset.currencyCode;
    const snapshot = await this.prisma.assetPriceSnapshot.findFirst({
      where: {
        assetId: asset.id,
        currencyCode: priceCurrency,
        price: {
          gt: 0,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        price: true,
        priceKrw: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    if (!snapshot) {
      return null;
    }

    const priceKrw = await this.resolvePriceKrw({
      price: snapshot.price,
      priceKrw: snapshot.priceKrw,
      priceCurrency,
      effectiveAt: snapshot.effectiveAt,
    });
    const now = new Date();

    return {
      type: 'asset_ticker',
      assetId: asset.id,
      symbol: asset.symbol,
      name: asset.name,
      priceLocal: snapshot.price.toFixed(8),
      priceCurrency,
      priceKrw: priceKrw ? priceKrw.toFixed(8) : null,
      priceKrwState: priceKrw ? 'available' : 'unavailable',
      changeRate: null,
      assetPriceSnapshotId: snapshot.id,
      priceCapturedAt: snapshot.capturedAt.toISOString(),
      priceEffectiveAt: snapshot.effectiveAt.toISOString(),
      freshnessAgeSeconds: Math.max(
        0,
        Math.floor((now.getTime() - snapshot.capturedAt.getTime()) / 1000),
      ),
    };
  }

  private async resolvePriceKrw(input: {
    price: Prisma.Decimal;
    priceKrw: Prisma.Decimal | null;
    priceCurrency: CurrencyCode;
    effectiveAt: Date;
  }): Promise<Prisma.Decimal | null> {
    if (input.priceKrw) {
      return input.priceKrw;
    }

    if (input.priceCurrency === CurrencyCode.KRW) {
      return input.price;
    }

    const fxRate = await this.prisma.fxRateSnapshot.findFirst({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        rate: {
          gt: 0,
        },
        effectiveAt: {
          lte: input.effectiveAt,
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        rate: true,
      },
    });

    return fxRate ? input.price.mul(fxRate.rate) : null;
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
}
