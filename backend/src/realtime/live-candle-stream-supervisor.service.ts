import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WebSocket as WsWebSocket } from 'ws';
import { AssetType, CurrencyCode } from '../generated/prisma/client';
import {
  BINANCE_MAX_STREAMS_PER_CONNECTION,
  LIVE_CANDLE_CONFIG,
  type LiveCandleConfig,
} from '../assets/live-candle.config';
import {
  LiveCandleEventNormalizerService,
  LiveCandleEventValidationError,
  type LiveCandleAsset,
} from '../assets/live-candle-event-normalizer.service';
import { LiveCandleHealthService } from '../assets/live-candle-health.service';
import { LiveCandlePipelineService } from '../assets/live-candle-pipeline.service';
import { buildLiveCandleOwnerLeaseKey } from '../assets/live-candle-store.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisLockService, type RedisLock } from '../redis/redis-lock.service';
import { parseBinanceMarketStreamFrame } from '../providers/binance/binance-kline.parser';
import { NormalizedProviderTradeEventBus } from '../providers/normalized-provider-trade-event-bus.service';
import {
  ProviderTradeRouteRegistry,
  type ProviderSubscribedAsset,
} from '../providers/provider-trade-route.registry';
import { ProviderConfigService } from '../providers/provider-config.service';
import { toBinanceUsdtSymbol } from '../providers/provider-target-resolver.service';
import { KisAuthClient } from '../providers/kis/kis-auth.client';
import { parseKisWebSocketMessage } from '../providers/kis/kis-websocket.trade-parser';
import { readLimitOrderMatchingConfig } from '../orders/limit-matching/limit-order-matching.config';
import {
  buildKisDomesticSubscriptionTarget,
  buildKisUsDelayedSubscriptionTarget,
  buildKisWebSocketSubscriptionRequest,
  normalizeKisUsMarketCode,
} from '../providers/kis/kis-websocket.subscription';
import { ProviderPricePubSubService } from './provider-price-pubsub.service';

export const LIVE_CANDLE_SOCKET_FACTORY = Symbol('LIVE_CANDLE_SOCKET_FACTORY');

export type LiveCandleSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  pong?(data?: Buffer): void;
};

export type LiveCandleSocketFactory = (url: string) => LiveCandleSocket;

type ProviderName = 'binance' | 'kis';
type OwnedProviderContext = {
  provider: ProviderName;
  lock: RedisLock;
  leaseKey: string;
  lost: boolean;
  socket: LiveCandleSocket | null;
  renewTimer: NodeJS.Timeout | null;
  /**
   * Per-CONNECTION identity (not per-ownership): a reconnect mints a new one
   * so every asset subscription readiness recorded under the previous socket
   * is invalidated and must be re-acknowledged before limit orders are
   * accepted again.
   */
  connectionGeneration: string;
};

/** Asset row plus the settlement currency the normalized trade event needs. */
type LiveCandleTradeAsset = LiveCandleAsset & {
  settlementCurrency: CurrencyCode;
};

const SOCKET_OPEN = 1;
const CONNECT_TIMEOUT_MS = 10_000;
const BINANCE_CONNECTION_LIFETIME_MS = 23 * 60 * 60_000 + 55 * 60_000;

@Injectable()
export class LiveCandleStreamSupervisorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LiveCandleStreamSupervisorService.name);
  private stopping = false;
  private tasks: Promise<void>[] = [];
  private readonly contexts = new Map<ProviderName, OwnedProviderContext>();
  private readonly pendingEvents = new Set<Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private readonly matching = readLimitOrderMatchingConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: RedisLockService,
    private readonly providerConfig: ProviderConfigService,
    private readonly kisAuth: KisAuthClient,
    private readonly pricePubSub: ProviderPricePubSubService,
    private readonly normalizer: LiveCandleEventNormalizerService,
    private readonly pipeline: LiveCandlePipelineService,
    private readonly health: LiveCandleHealthService,
    private readonly routes: ProviderTradeRouteRegistry,
    private readonly tradeEvents: NormalizedProviderTradeEventBus,
    @Inject(LIVE_CANDLE_CONFIG) private readonly config: LiveCandleConfig,
    @Inject(LIVE_CANDLE_SOCKET_FACTORY)
    private readonly socketFactory: LiveCandleSocketFactory,
  ) {}

  /**
   * True when this supervisor must also act as the canonical EXACT-TRADE
   * source for the limit-order matcher. When it is, the legacy streaming
   * service for the same provider must neither connect nor publish, so there
   * is exactly one socket and exactly one publisher per provider.
   */
  private ownsTradeRoute(provider: ProviderName): boolean {
    return (
      this.matching.enabled &&
      this.routes.isOwnedBy(provider, 'live_candle_supervisor')
    );
  }

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.config.enabled || this.tasks.length > 0) return;
    this.stopping = false;
    if (this.config.binanceEnabled) {
      this.tasks.push(this.runOwnershipLoop('binance'));
    }
    if (this.config.kisEnabled) {
      this.tasks.push(this.runOwnershipLoop('kis'));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    for (const context of this.contexts.values()) {
      context.socket?.close(1000, 'live candle shutdown');
    }
    await Promise.allSettled(this.tasks);
    await Promise.allSettled([...this.pendingEvents]);
    this.tasks = [];
    this.contexts.clear();
  }

  getStatus() {
    return this.health.snapshot();
  }

  private async runOwnershipLoop(provider: ProviderName): Promise<void> {
    const leaseKey = buildLiveCandleOwnerLeaseKey(provider);
    while (!this.stopping) {
      const acquired = await this.locks.acquire(
        leaseKey,
        this.config.ownerLeaseTtlMs,
      );
      if (acquired.status !== 'acquired') {
        this.health.updateProvider(provider, {
          state: acquired.status === 'error' ? 'degraded' : 'waiting_owner',
          owner: false,
          lastErrorCode:
            acquired.status === 'error' ? 'REDIS_OWNER_UNAVAILABLE' : null,
        });
        await this.sleep(this.config.ownerLeaseRenewMs);
        continue;
      }
      const context: OwnedProviderContext = {
        provider,
        lock: acquired.lock,
        leaseKey,
        lost: false,
        socket: null,
        renewTimer: null,
        connectionGeneration: '',
      };
      this.contexts.set(provider, context);
      // Exclusive claim of the provider's exact-trade route. It is taken even
      // when automatic matching is off, so the legacy streaming service can
      // always tell whether a canonical connection already exists.
      this.routes.claimProvider(provider, 'live_candle_supervisor');
      this.health.updateProvider(provider, {
        owner: true,
        state: 'connecting',
        lastErrorCode: null,
      });
      this.startLeaseRenewal(context);
      await this.runOwnedConnections(context);
      if (context.renewTimer) clearInterval(context.renewTimer);
      context.socket?.close(1000, 'owner released');
      this.routes.releaseProvider(provider, 'live_candle_supervisor');
      await this.locks.release(context.lock);
      if (this.contexts.get(provider) === context)
        this.contexts.delete(provider);
      this.health.updateProvider(provider, {
        owner: false,
        state: this.stopping ? 'stopped' : 'waiting_owner',
      });
    }
  }

  private startLeaseRenewal(context: OwnedProviderContext): void {
    context.renewTimer = setInterval(() => {
      void this.locks
        .extend(context.lock, this.config.ownerLeaseTtlMs)
        .then((renewed) => {
          if (renewed || context.lost) return;
          context.lost = true;
          context.socket?.close(4003, 'owner lease lost');
          this.health.updateProvider(context.provider, {
            owner: false,
            state: 'degraded',
            lastErrorCode: 'OWNER_LEASE_LOST',
          });
        });
    }, this.config.ownerLeaseRenewMs);
    context.renewTimer.unref?.();
  }

  private async runOwnedConnections(
    context: OwnedProviderContext,
  ): Promise<void> {
    let attempt = 0;
    while (!this.stopping && !context.lost) {
      try {
        this.health.updateProvider(context.provider, {
          state: attempt === 0 ? 'connecting' : 'reconnecting',
        });
        // A fresh generation per connection attempt: every asset readiness
        // from the previous socket is dropped here and only becomes valid
        // again once the new socket re-subscribes and is acknowledged.
        context.connectionGeneration = `${context.lock.token}:${randomUUID()}`;
        this.routes.beginConnection({
          provider: context.provider,
          source: 'live_candle_supervisor',
          generation: context.connectionGeneration,
        });
        if (context.provider === 'binance') {
          await this.connectBinance(context);
        } else {
          await this.connectKis(context);
        }
        attempt = 0;
        // The socket closed without throwing (provider-initiated close,
        // scheduled rollover, or an operator-forced reconnect); record why
        // the loop is reconnecting.
        if (!this.stopping && !context.lost) {
          this.logReconnect(context.provider, 'socket_closed', null);
        }
      } catch (error) {
        const failedSocket = context.socket;
        if (failedSocket) {
          failedSocket.removeAllListeners();
          try {
            failedSocket.close(1011, 'stream connection failed');
          } catch {
            // A socket can already be terminal after a handshake error.
          }
          if (context.socket === failedSocket) context.socket = null;
        }
        const code = error instanceof Error ? error.name : 'STREAM_ERROR';
        this.logReconnect(context.provider, code, null);
        this.health.updateProvider(context.provider, {
          state: 'reconnecting',
          lastErrorCode: code,
        });
      }
      this.routes.endConnection({
        provider: context.provider,
        generation: context.connectionGeneration,
      });
      if (this.stopping || context.lost) break;
      await this.pipeline.markProviderContinuityLost({
        provider: context.provider,
        ownerGeneration: context.lock.token,
        ownerLeaseKey: context.leaseKey,
      });
      const reconnectCount =
        this.health.snapshot().providers[context.provider].reconnectCount + 1;
      this.health.updateProvider(context.provider, { reconnectCount });
      const exponential = Math.min(
        this.config.reconnectMaxMs,
        this.config.reconnectMinMs * 2 ** Math.min(attempt, 8),
      );
      const jitter = Math.floor(exponential * 0.2 * Math.random());
      attempt += 1;
      await this.sleep(
        Math.min(this.config.reconnectMaxMs, exponential + jitter),
      );
    }
  }

  private async connectBinance(context: OwnedProviderContext): Promise<void> {
    const provider = this.providerConfig.getConfig();
    if (
      !provider.common.providerIngestionEnabled ||
      !provider.binance.enabled
    ) {
      throw namedError('BINANCE_PROVIDER_DISABLED');
    }
    const assets = await this.loadAssets(AssetType.crypto);
    const bySymbol = new Map<string, LiveCandleTradeAsset>();
    for (const asset of assets) {
      const symbol = toBinanceUsdtSymbol(asset.symbol.trim().toUpperCase());
      if (symbol) bySymbol.set(symbol, asset);
    }
    const desiredSymbols = [...bySymbol.keys()];
    // The matcher's exact-trade feed rides the SAME connection as the candle
    // klines: one socket, two stream families, no second Binance WebSocket.
    const tradeRouteOwned = this.ownsTradeRoute('binance');
    // Binance limits STREAMS, not assets, and an asset costs two streams while
    // the matcher owns this route. Deriving the asset budget from the stream
    // budget is what keeps a legitimate asset cap from silently producing a
    // rejected 2048-stream SUBSCRIBE.
    const streamsPerAsset = tradeRouteOwned ? 2 : 1;
    const assetBudget = Math.min(
      this.config.maxProviderSubscriptionsPerShard,
      Math.floor(this.config.maxProviderStreamsPerShard / streamsPerAsset),
    );
    const subscribedSymbols = desiredSymbols.slice(0, Math.max(0, assetBudget));
    const cappedSymbols = desiredSymbols.slice(subscribedSymbols.length);
    const streams = subscribedSymbols.flatMap((symbol) =>
      tradeRouteOwned
        ? [`${symbol.toLowerCase()}@kline_5m`, `${symbol.toLowerCase()}@trade`]
        : [`${symbol.toLowerCase()}@kline_5m`],
    );
    if (streams.length === 0) throw namedError('BINANCE_STREAMS_EMPTY');
    // Last-line assertion on what is ACTUALLY sent, not on what the cap
    // arithmetic believed it would send. A future change to the stream families
    // (a third stream per asset, a per-asset exception) fails here loudly
    // instead of producing a connection that silently carries no data.
    if (streams.length > BINANCE_MAX_STREAMS_PER_CONNECTION) {
      throw namedError('BINANCE_STREAM_CAP_EXCEEDED');
    }
    const socket = this.socketFactory(
      `${provider.binance.wsMarketDataBaseUrl.replace(/\/+$/u, '')}/ws`,
    );
    context.socket = socket;
    await waitForOpen(socket);
    if (context.lost || this.stopping) return;
    this.routes.markConnectionOpen({
      provider: 'binance',
      generation: context.connectionGeneration,
      at: Date.now(),
    });
    this.routes.registerSubscriptionTargets({
      provider: 'binance',
      generation: context.connectionGeneration,
      assets: subscribedSymbols.map((symbol) =>
        binanceSubscribedAsset(
          bySymbol.get(symbol) as LiveCandleTradeAsset,
          symbol,
        ),
      ),
      cappedAssets: cappedSymbols.map((symbol) =>
        binanceSubscribedAsset(
          bySymbol.get(symbol) as LiveCandleTradeAsset,
          symbol,
        ),
      ),
    });
    let lastFrameAt = Date.now();
    const heartbeat = setInterval(
      () => {
        // Connection liveness is judged from ANY frame (data, WS ping, or
        // control), never from trade traffic alone. Trade freshness is a
        // separate readiness-only signal (tradeStaleThresholdMs) and must
        // never close the socket.
        if (
          Date.now() - lastFrameAt >
          this.config.connectionLivenessTimeoutMs
        ) {
          this.logReconnect('binance', 'liveness_timeout', lastFrameAt);
          socket.close(4000, 'liveness timeout');
        }
      },
      Math.max(1_000, Math.min(5_000, this.config.connectionLivenessTimeoutMs)),
    );
    heartbeat.unref?.();
    const rollover = setTimeout(() => {
      this.logReconnect('binance', 'scheduled_rollover', lastFrameAt);
      socket.close(4001, 'scheduled rollover');
    }, BINANCE_CONNECTION_LIFETIME_MS);
    rollover.unref?.();
    socket.on('ping', (data?: Buffer) => {
      socket.pong?.(data);
      lastFrameAt = Date.now();
      this.routes.markFrame({
        provider: 'binance',
        generation: context.connectionGeneration,
        at: lastFrameAt,
      });
      this.health.updateProvider('binance', {
        lastFrameAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        lastControlFrameAt: new Date().toISOString(),
      });
    });
    socket.on('message', (data: unknown) => {
      lastFrameAt = Date.now();
      this.routes.markFrame({
        provider: 'binance',
        generation: context.connectionGeneration,
        at: lastFrameAt,
      });
      this.health.updateProvider('binance', {
        lastFrameAt: new Date().toISOString(),
      });
      this.handleBinanceMessage(data, bySymbol, context);
    });
    socket.send(
      JSON.stringify({ method: 'SUBSCRIBE', params: streams, id: 1 }),
    );
    this.health.updateProvider('binance', {
      state:
        desiredSymbols.length > subscribedSymbols.length
          ? 'degraded'
          : 'connected',
      connectedAt: new Date().toISOString(),
      subscriptionsRequested: desiredSymbols.length,
      subscriptionsActive: subscribedSymbols.length,
      subscriptionsFailed: cappedSymbols.length,
      delayed: false,
      lastErrorCode: cappedSymbols.length > 0 ? 'SUBSCRIPTION_SHARD_CAP' : null,
    });
    await waitForClose(socket);
    clearInterval(heartbeat);
    clearTimeout(rollover);
    if (context.socket === socket) context.socket = null;
  }

  private async connectKis(context: OwnedProviderContext): Promise<void> {
    const provider = this.providerConfig.getConfig();
    if (
      !provider.common.providerIngestionEnabled ||
      !provider.kis.enabled ||
      !provider.kis.wsBaseUrl
    ) {
      throw namedError('KIS_PROVIDER_DISABLED');
    }
    const approval = await this.kisAuth.requestConfiguredWebSocketApprovalKey();
    if (approval.state !== 'available') throw namedError(approval.reason);
    const [domestic, us] = await Promise.all([
      this.loadAssets(AssetType.domestic_stock),
      this.config.kisUsDelayedEnabled
        ? this.loadAssets(AssetType.us_stock)
        : Promise.resolve([]),
    ]);
    const desiredTargets = [
      ...domestic.map((asset) => ({
        asset,
        target: buildKisDomesticSubscriptionTarget({
          symbol: asset.symbol,
          trId: provider.kis.wsDomesticTrId,
        }),
      })),
      ...us.flatMap((asset) => {
        const marketCode = normalizeKisUsMarketCode(asset.market);
        return marketCode
          ? [
              {
                asset,
                target: buildKisUsDelayedSubscriptionTarget({
                  symbol: asset.symbol,
                  marketCode,
                  trId: provider.kis.wsOverseasDelayedTrId,
                }),
              },
            ]
          : [];
      }),
    ];
    const targets = desiredTargets.slice(
      0,
      this.config.maxProviderSubscriptionsPerShard,
    );
    const cappedTargets = desiredTargets.slice(targets.length);
    if (targets.length === 0) throw namedError('KIS_STREAMS_EMPTY');
    const byKey = new Map(
      targets.map(({ asset, target }) => [
        kisAssetKey(target.kind, target.marketCode, target.symbol),
        asset,
      ]),
    );
    const socket = this.socketFactory(provider.kis.wsBaseUrl);
    context.socket = socket;
    await waitForOpen(socket);
    if (context.lost || this.stopping) return;
    this.routes.markConnectionOpen({
      provider: 'kis',
      generation: context.connectionGeneration,
      at: Date.now(),
    });
    this.routes.registerSubscriptionTargets({
      provider: 'kis',
      generation: context.connectionGeneration,
      assets: targets.map(({ asset, target }) =>
        kisSubscribedAsset(asset, target.trKey),
      ),
      cappedAssets: cappedTargets.map(({ asset, target }) =>
        kisSubscribedAsset(asset, target.trKey),
      ),
    });
    let lastFrameAt = Date.now();
    const heartbeat = setInterval(
      () => {
        // KIS connection liveness: any frame (PINGPONG heartbeat, ack, WS
        // ping, or trade) resets the timer. A quiet market with heartbeats
        // flowing must never trigger a reconnect; only a truly silent socket
        // (no trades AND no control frames) does. Trade staleness is judged
        // separately by readiness via tradeStaleThresholdMs.
        if (
          Date.now() - lastFrameAt >
          this.config.connectionLivenessTimeoutMs
        ) {
          this.logReconnect('kis', 'liveness_timeout', lastFrameAt);
          socket.close(4000, 'liveness timeout');
        }
      },
      Math.max(1_000, Math.min(5_000, this.config.connectionLivenessTimeoutMs)),
    );
    heartbeat.unref?.();
    socket.on('ping', (data?: Buffer) => {
      socket.pong?.(data);
      lastFrameAt = Date.now();
      this.routes.markFrame({
        provider: 'kis',
        generation: context.connectionGeneration,
        at: lastFrameAt,
      });
      this.health.updateProvider('kis', {
        lastFrameAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        lastControlFrameAt: new Date().toISOString(),
      });
    });
    socket.on('message', (data: unknown) => {
      lastFrameAt = Date.now();
      this.routes.markFrame({
        provider: 'kis',
        generation: context.connectionGeneration,
        at: lastFrameAt,
      });
      this.health.updateProvider('kis', {
        lastFrameAt: new Date().toISOString(),
      });
      this.handleKisMessage(data, byKey, context);
    });
    for (const { target } of targets) {
      socket.send(
        JSON.stringify(
          buildKisWebSocketSubscriptionRequest({
            approvalKey: approval.response.approvalKey,
            custType: provider.kis.wsCustType,
            action: 'subscribe',
            trId: target.trId,
            trKey: target.trKey,
          }),
        ),
      );
    }
    this.health.updateProvider('kis', {
      state: cappedTargets.length > 0 ? 'degraded' : 'connected',
      connectedAt: new Date().toISOString(),
      subscriptionsRequested: desiredTargets.length,
      subscriptionsActive: targets.length,
      subscriptionsFailed: cappedTargets.length,
      delayed: us.length > 0,
      lastErrorCode: cappedTargets.length > 0 ? 'SUBSCRIPTION_SHARD_CAP' : null,
    });
    await waitForClose(socket);
    clearInterval(heartbeat);
    if (context.socket === socket) context.socket = null;
  }

  private handleBinanceMessage(
    data: unknown,
    assets: Map<string, LiveCandleTradeAsset>,
    context: OwnedProviderContext,
  ): void {
    const text = socketDataToText(data);
    if (!text) return this.health.increment('eventsRejected');
    // ONE parse per frame decides the branch: klines feed the candle
    // pipeline, exact trades feed the limit-order matcher.
    const parsed = parseBinanceMarketStreamFrame(text);
    if (parsed.state === 'ack') {
      // Binance answers one SUBSCRIBE with one result frame; that ack is the
      // activation signal for every stream in the batch.
      this.routes.markSubscriptionsActive({
        provider: 'binance',
        generation: context.connectionGeneration,
      });
      return;
    }
    if (parsed.state === 'trade') {
      const tradeAsset = assets.get(parsed.trade.symbol);
      if (!tradeAsset) return this.health.increment('eventsRejected');
      this.publishNormalizedTrade(context, {
        provider: 'binance',
        providerEventId: parsed.trade.tradeId,
        providerSequence: parsed.trade.tradeId,
        providerConnectionId: context.connectionGeneration,
        assetId: tradeAsset.id,
        symbol: tradeAsset.symbol,
        providerSymbol: parsed.trade.symbol,
        price: parsed.trade.price,
        currencyCode: tradeAsset.settlementCurrency,
        providerEventAt: parsed.trade.tradeTime.toISOString(),
        receivedAt: new Date().toISOString(),
        sourceName: 'binance_spot_ws_trade',
        marketSessionCode: null,
        eventType: 'trade',
      });
      return;
    }
    if (parsed.state !== 'kline') {
      if (parsed.state === 'failed') {
        this.health.increment('eventsRejected');
        if (parsed.reason === 'BINANCE_SUBSCRIPTION_FAILED') {
          this.recordSubscriptionFailure('binance');
          this.routes.markSubscriptionsFailed({
            provider: 'binance',
            generation: context.connectionGeneration,
          });
          context.socket?.close(1011, 'subscription rejected');
        }
      }
      return;
    }
    const asset = assets.get(parsed.kline.symbol);
    if (!asset) return this.health.increment('eventsRejected');
    this.trackEvent('binance', parsed.kline.eventTime, async () => {
      const event = this.normalizer.normalizeBinance(
        parsed.kline,
        asset,
        new Date(),
      );
      this.pipeline.markProviderConnected({
        provider: 'binance',
        ownerGeneration: context.lock.token,
        connectedAt: event.eventTime,
      });
      const result = await this.pipeline.process({
        event,
        ownerGeneration: context.lock.token,
        ownerLeaseKey: context.leaseKey,
      });
      if (result.status === 'updated') {
        const updatedAt = new Date().toISOString();
        const published = await this.pricePubSub.publish({
          type: 'binance_realtime_price',
          assetId: asset.id,
          snapshotState: null,
          price: {
            key: parsed.kline.symbol,
            providerSymbol: parsed.kline.symbol,
            streamName: `${parsed.kline.symbol.toLowerCase()}@kline_5m`,
            price: event.price,
            changeRate: null,
            bidPrice: null,
            askPrice: null,
            currencyCode: 'USD',
            sourceName: event.source,
            effectiveAt: event.eventTime.toISOString(),
            capturedAt: event.receivedAt.toISOString(),
            updatedAt,
          },
        });
        if (!published) this.health.increment('pubSubPublishFailure');
      }
      return result;
    });
  }

  private handleKisMessage(
    data: unknown,
    assets: Map<string, LiveCandleTradeAsset>,
    context: OwnedProviderContext,
  ): void {
    const text = socketDataToText(data);
    if (!text) return this.health.increment('eventsRejected');
    const parsed = parseKisWebSocketMessage({
      frame: text,
      receivedAt: new Date(),
    });
    if (parsed.state !== 'trades') {
      if (parsed.state === 'heartbeat') {
        // Official KIS PINGPONG: echo it back verbatim and record control
        // liveness. Never counted as a trade-parser failure.
        try {
          context.socket?.send(parsed.rawFrame);
        } catch {
          // Echo failures surface through the liveness timeout.
        }
        this.health.updateProvider('kis', {
          lastHeartbeatAt: new Date().toISOString(),
          lastControlFrameAt: new Date().toISOString(),
        });
        return;
      }
      if (parsed.state === 'ack') {
        // KIS acknowledges each subscribe individually and echoes the
        // tr_key; only that asset becomes ready.
        this.routes.markSubscriptionsActive({
          provider: 'kis',
          generation: context.connectionGeneration,
          match: subscriptionKeyMatcher(parsed.trKey),
        });
        this.health.updateProvider('kis', {
          lastControlFrameAt: new Date().toISOString(),
        });
        return;
      }
      if (parsed.state === 'failed') {
        this.health.increment('eventsRejected');
        if (parsed.reason === 'KIS_SUBSCRIPTION_ACK_FAILED') {
          this.recordSubscriptionFailure('kis', 1);
          this.routes.markSubscriptionsFailed({
            provider: 'kis',
            generation: context.connectionGeneration,
            match: subscriptionKeyMatcher(parsed.trKey),
          });
          this.logReconnect('kis', 'subscription_rejected', Date.now());
          context.socket?.close(1011, 'subscription rejected');
        }
      }
      return;
    }
    for (const trade of parsed.trades) {
      const asset = assets.get(
        kisAssetKey(trade.kind, trade.marketCode, trade.symbol),
      );
      if (!asset) {
        this.health.increment('eventsRejected');
        continue;
      }
      const eventTime = trade.exchangeTimestamp ?? trade.sourceTimestamp;
      // The SAME parsed trade record feeds the candle pipeline, the price
      // display pub/sub, and the limit-order matcher. The frame is parsed
      // exactly once, above.
      this.publishNormalizedTrade(context, {
        provider: 'kis',
        providerEventId: trade.eventId,
        providerSequence: trade.sequence,
        providerConnectionId: context.connectionGeneration,
        assetId: asset.id,
        symbol: asset.symbol,
        providerSymbol: trade.providerSymbol,
        price: trade.price,
        currencyCode: asset.settlementCurrency,
        providerEventAt: (eventTime ?? trade.receivedAt).toISOString(),
        receivedAt: trade.receivedAt.toISOString(),
        sourceName:
          trade.kind === 'domestic_krx_realtime_trade'
            ? 'kis_krx_realtime_trade'
            : 'kis_us_delayed_trade',
        marketSessionCode: trade.marketSessionCode,
        eventType: 'trade',
      });
      this.trackEvent('kis', eventTime, async () => {
        const event = this.normalizer.normalizeKis(trade, asset);
        this.pipeline.markProviderConnected({
          provider: 'kis',
          ownerGeneration: context.lock.token,
          connectedAt: event.eventTime,
        });
        const result = await this.pipeline.process({
          event,
          ownerGeneration: context.lock.token,
          ownerLeaseKey: context.leaseKey,
        });
        if (result.status === 'updated') {
          const published = await this.pricePubSub.publish({
            type: 'kis_realtime_price',
            assetId: asset.id,
            snapshotState: null,
            price: {
              key: `${trade.kind}:${trade.symbol.trim().toUpperCase()}`,
              kind: trade.kind,
              trId: trade.trId,
              providerSymbol: trade.providerSymbol,
              symbol: trade.symbol,
              marketCode: trade.marketCode,
              price: event.price,
              currencyCode:
                asset.assetType === AssetType.domestic_stock
                  ? CurrencyCode.KRW
                  : CurrencyCode.USD,
              sourceName: event.source,
              effectiveAt: event.eventTime.toISOString(),
              capturedAt: event.receivedAt.toISOString(),
              updatedAt: new Date().toISOString(),
            },
          });
          if (!published) this.health.increment('pubSubPublishFailure');
        }
        return result;
      });
    }
  }

  private trackEvent(
    provider: ProviderName,
    eventTime: Date | null,
    operation: () => Promise<unknown>,
  ): void {
    const promise = operation()
      .then(() => {
        const now = new Date();
        this.health.updateProvider(provider, {
          lastEventAt: now.toISOString(),
          eventLagMs: eventTime
            ? Math.max(0, now.getTime() - eventTime.getTime())
            : null,
        });
      })
      .catch((error: unknown) => {
        this.health.increment('eventsRejected');
        if (!(error instanceof LiveCandleEventValidationError)) {
          this.health.updateProvider(provider, {
            lastErrorCode: error instanceof Error ? error.name : 'EVENT_ERROR',
          });
        }
      })
      .finally(() => this.pendingEvents.delete(promise));
    this.pendingEvents.add(promise);
  }

  /**
   * Structured reconnect diagnostics: reason plus how stale the connection
   * and market data were, so silent-market reconnect loops are visible.
   */
  private logReconnect(
    provider: ProviderName,
    reason: string,
    lastFrameAtMs: number | null,
  ): void {
    const snapshot = this.health.snapshot().providers[provider];
    this.logger.warn(
      JSON.stringify({
        event: 'live_candle_stream_reconnect',
        provider,
        reason,
        lastFrameAgeMs:
          lastFrameAtMs !== null ? Date.now() - lastFrameAtMs : null,
        lastEventAt: snapshot.lastEventAt,
        lastHeartbeatAt: snapshot.lastHeartbeatAt,
      }),
    );
  }

  private recordSubscriptionFailure(
    provider: ProviderName,
    count?: number,
  ): void {
    const current = this.health.snapshot().providers[provider];
    const failed = Math.min(
      current.subscriptionsRequested,
      current.subscriptionsFailed +
        (count ?? Math.max(1, current.subscriptionsActive)),
    );
    this.health.updateProvider(provider, {
      state: 'degraded',
      subscriptionsFailed: failed,
      subscriptionsActive: Math.max(0, current.subscriptionsRequested - failed),
      lastErrorCode: 'SUBSCRIPTION_REJECTED',
    });
  }

  /**
   * Publishes an exact trade onto the normalized bus, but only while this
   * supervisor owns the provider's trade route AND automatic matching is on.
   * Everything the downstream publisher needs about the asset rides along on
   * the event, so no per-trade `assets` query happens anywhere on this path.
   */
  private publishNormalizedTrade(
    context: OwnedProviderContext,
    tick: Omit<
      Parameters<NormalizedProviderTradeEventBus['publish']>[0],
      'asset'
    >,
  ): void {
    if (!this.ownsTradeRoute(context.provider)) return;
    const registered = this.routes.resolveAsset(
      context.provider,
      tick.assetId,
      context.connectionGeneration,
    );
    // A trade for an asset that is not part of THIS generation's subscription
    // set is never turned into matching evidence.
    if (!registered) return;
    this.tradeEvents.publish({
      ...tick,
      asset: {
        assetId: registered.assetId,
        symbol: registered.symbol,
        market: registered.market,
        assetType: registered.assetType,
        settlementCurrency: registered.settlementCurrency,
        generation: context.connectionGeneration,
      },
    });
  }

  private loadAssets(assetType: AssetType): Promise<LiveCandleTradeAsset[]> {
    return this.prisma.asset.findMany({
      where: { isActive: true, assetType },
      select: {
        id: true,
        symbol: true,
        assetType: true,
        market: true,
        isActive: true,
        settlementCurrency: true,
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
    });
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      // `finish` only runs asynchronously (timer callback or an external
      // wake), so it always observes the initialized timer below.
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      this.waiters.add(finish);
    });
  }
}

export function defaultLiveCandleSocketFactory(url: string): LiveCandleSocket {
  return new WsWebSocket(url) as unknown as LiveCandleSocket;
}

function waitForOpen(socket: LiveCandleSocket): Promise<void> {
  if (socket.readyState === SOCKET_OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(namedError('STREAM_CONNECT_TIMEOUT'));
    }, CONNECT_TIMEOUT_MS);
    const open = () => {
      cleanup();
      resolve();
    };
    const error = () => {
      cleanup();
      reject(namedError('STREAM_CONNECT_FAILED'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners('open');
      socket.removeAllListeners('error');
    };
    socket.on('open', open);
    socket.on('error', error);
  });
}

function waitForClose(socket: LiveCandleSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.on('close', () => {
      socket.removeAllListeners();
      resolve();
    });
    socket.on('error', () => socket.close(1011, 'stream error'));
  });
}

function socketDataToText(data: unknown): string | null {
  const value =
    data && typeof data === 'object' && 'data' in data
      ? (data as { data: unknown }).data
      : data;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).toString('utf8');
  }
  return null;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function kisAssetKey(
  kind: string,
  marketCode: string | null,
  symbol: string,
): string {
  return `${kind}:${marketCode?.trim().toUpperCase() ?? ''}:${symbol.trim().toUpperCase()}`;
}

function binanceSubscribedAsset(
  asset: LiveCandleTradeAsset,
  providerSymbol: string,
): ProviderSubscribedAsset {
  return {
    assetId: asset.id,
    symbol: asset.symbol,
    providerSymbol,
    market: asset.market,
    assetType: asset.assetType,
    settlementCurrency: asset.settlementCurrency,
    sourceName: 'binance_spot_ws_trade',
  };
}

function kisSubscribedAsset(
  asset: LiveCandleTradeAsset,
  trKey: string,
): ProviderSubscribedAsset {
  return {
    assetId: asset.id,
    symbol: asset.symbol,
    providerSymbol: trKey,
    market: asset.market,
    assetType: asset.assetType,
    settlementCurrency: asset.settlementCurrency,
    sourceName:
      asset.assetType === AssetType.domestic_stock
        ? 'kis_krx_realtime_trade'
        : 'kis_us_delayed_trade',
  };
}

/**
 * KIS echoes the subscribed tr_key on its ack. A null key means the frame did
 * not identify a target — treat it as covering nothing rather than silently
 * activating every pending subscription.
 */
function subscriptionKeyMatcher(
  trKey: string | null,
): (asset: ProviderSubscribedAsset) => boolean {
  const normalized = trKey?.trim().toUpperCase() ?? '';
  return (asset) =>
    normalized.length > 0 &&
    asset.providerSymbol.trim().toUpperCase() === normalized;
}
