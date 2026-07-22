jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  };
});
jest.mock('../assets/live-candle-pipeline.service', () => ({
  LiveCandlePipelineService: class LiveCandlePipelineService {},
}));

import { EventEmitter } from 'node:events';
import { readLiveCandleConfig } from '../assets/live-candle.config';
import { LiveCandleHealthService } from '../assets/live-candle-health.service';
import { ProviderTradeRouteRegistry } from '../providers/provider-trade-route.registry';
import { NormalizedProviderTradeEventBus } from '../providers/normalized-provider-trade-event-bus.service';
import { LiveCandleStreamSupervisorService } from './live-candle-stream-supervisor.service';

describe('LiveCandleStreamSupervisorService', () => {
  it('opens one Binance owner connection, subscribes native 5m klines, handles ping, and restores pipeline continuity', async () => {
    const socket = new FakeSocket();
    const fixture = setup(() => socket);
    const context = ownerContext();
    const connected = connectBinance(fixture.service, context);
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('ping', Buffer.from('heartbeat'));
    socket.emit('message', binanceFrame());
    await Promise.resolve();
    socket.close(1000, 'fixture done');
    await connected;
    await Promise.resolve();

    expect(fixture.factory).toHaveBeenCalledWith('wss://stream.example/ws');
    expect(JSON.parse(socket.sent[0])).toEqual({
      method: 'SUBSCRIBE',
      params: ['btcusdt@kline_5m'],
      id: 1,
    });
    expect(socket.pong).toHaveBeenCalledWith(Buffer.from('heartbeat'));
    expect(fixture.pipeline.markProviderConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'binance',
        ownerGeneration: 'owner-1',
      }),
    );
    expect(fixture.pipeline.process).toHaveBeenCalledTimes(1);
    expect(fixture.pricePubSub.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'binance_realtime_price',
        assetId: 'btc',
        price: expect.objectContaining({ price: '105.00000000' }) as unknown,
      }),
    );
    expect(fixture.health.snapshot().providers.binance).toMatchObject({
      state: 'connected',
      subscriptionsActive: 1,
      delayed: false,
    });
  });

  it('uses bounded exponential reconnect without overlapping connection attempts', async () => {
    const fixture = setup(() => new FakeSocket());
    const service = fixture.service as unknown as {
      stopping: boolean;
      connectBinance(context: unknown): Promise<void>;
      runOwnedConnections(context: unknown): Promise<void>;
      sleep(ms: number): Promise<void>;
    };
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const connect = jest
      .spyOn(service, 'connectBinance')
      .mockRejectedValueOnce(new Error('disconnect-1'))
      .mockRejectedValueOnce(new Error('disconnect-2'))
      .mockImplementationOnce(() => {
        service.stopping = true;
        return Promise.resolve();
      });
    const sleep = jest.spyOn(service, 'sleep').mockResolvedValue();

    await service.runOwnedConnections(ownerContext());

    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
    expect(fixture.pipeline.markProviderContinuityLost).toHaveBeenCalledTimes(
      2,
    );
    jest.restoreAllMocks();
  });

  it('reports assets beyond the bounded shard capacity as failed subscriptions', async () => {
    const socket = new FakeSocket();
    const fixture = setup(
      () => socket,
      [cryptoAsset('btc', 'BTC'), cryptoAsset('eth', 'ETH')],
      1,
    );
    const connected = connectBinance(fixture.service, ownerContext());
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.close(1000, 'fixture done');
    await connected;

    expect(fixture.health.snapshot().providers.binance).toMatchObject({
      state: 'degraded',
      subscriptionsRequested: 2,
      subscriptionsActive: 1,
      subscriptionsFailed: 1,
      lastErrorCode: 'SUBSCRIPTION_SHARD_CAP',
    });
  });

  it('closes and degrades a stream when the provider rejects its subscription', async () => {
    const socket = new FakeSocket();
    const fixture = setup(() => socket);
    const connected = connectBinance(fixture.service, ownerContext());
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit(
      'message',
      JSON.stringify({ id: 1, code: 2, msg: 'subscription rejected' }),
    );
    await connected;

    expect(socket.closeCalls.at(-1)).toEqual([1011, 'subscription rejected']);
    expect(fixture.health.snapshot().providers.binance).toMatchObject({
      state: 'degraded',
      subscriptionsActive: 0,
      subscriptionsFailed: 1,
      lastErrorCode: 'SUBSCRIPTION_REJECTED',
    });
  });

  it('echoes KIS PINGPONG heartbeats and keeps the connection healthy without trades', async () => {
    const socket = new FakeSocket();
    const fixture = setup(
      () => socket,
      [
        {
          id: 'dom-1',
          symbol: '005930',
          assetType: 'domestic_stock',
          market: 'KOSPI',
          isActive: true,
        },
      ],
    );
    const connected = connectKis(fixture.service, {
      ...ownerContext(),
      provider: 'kis' as never,
    });
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    const pingpong = JSON.stringify({
      header: { tr_id: 'PINGPONG', datetime: '20260713113000' },
    });
    const subscribeCount = socket.sent.length;
    socket.emit('message', pingpong);
    // ack-only traffic: a successful subscription ack frame.
    socket.emit(
      'message',
      JSON.stringify({
        header: { tr_id: 'H0STCNT0' },
        body: { rt_cd: '0', msg1: 'SUBSCRIBE SUCCESS' },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    socket.close(1000, 'fixture done');
    await connected;

    // The heartbeat was echoed back verbatim.
    expect(socket.sent.slice(subscribeCount)).toContain(pingpong);
    const kis = fixture.health.snapshot().providers.kis;
    expect(kis.lastHeartbeatAt).not.toBeNull();
    expect(kis.lastControlFrameAt).not.toBeNull();
    expect(kis.lastFrameAt).not.toBeNull();
    // No trade arrived: market-data freshness stays unset, and nothing was
    // rejected or force-closed as a failure.
    expect(kis.lastEventAt).toBeNull();
    expect(fixture.health.snapshot().liveCandle.eventsRejected).toBe(0);
    expect(socket.closeCalls.filter(([code]) => code !== 1000)).toHaveLength(0);
  });

  it('handles malformed KIS control frames as rejected events without reconnecting', async () => {
    const socket = new FakeSocket();
    const fixture = setup(
      () => socket,
      [
        {
          id: 'dom-1',
          symbol: '005930',
          assetType: 'domestic_stock',
          market: 'KOSPI',
          isActive: true,
        },
      ],
    );
    const connected = connectKis(fixture.service, {
      ...ownerContext(),
      provider: 'kis' as never,
    });
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('message', '{"header": {"tr_id": "PINGPONG"');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.health.snapshot().liveCandle.eventsRejected).toBe(1);
    expect(socket.closeCalls).toHaveLength(0);
    socket.close(1000, 'fixture done');
    await connected;
  });

  it('keeps a heartbeating socket open past the trade-stale threshold and closes only on true frame silence', async () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const fixture = setup(() => socket, [cryptoAsset('btc', 'BTC')], 200, {
        // Trade freshness is deliberately far shorter than connection
        // liveness: the watchdog must ignore it entirely.
        connectionLivenessTimeoutMs: 60_000,
        tradeStaleThresholdMs: 5_000,
      });
      const connected = connectBinance(fixture.service, ownerContext());
      socket.open();
      await jest.advanceTimersByTimeAsync(0);

      // 50 seconds of heartbeat-only traffic (no trades). Every inter-frame
      // gap (10s) exceeds tradeStaleThresholdMs, yet the connection watchdog
      // never fires because frames keep arriving within the liveness window.
      for (let step = 0; step < 5; step += 1) {
        await jest.advanceTimersByTimeAsync(10_000);
        socket.emit('ping', Buffer.from('heartbeat'));
      }
      expect(socket.closeCalls).toHaveLength(0);

      // Full silence — no frames of any kind — exceeds the liveness timeout
      // and closes the socket for the reconnect loop. 70s covers the 60s
      // timeout plus one 5s watchdog tick of scheduling slack.
      await jest.advanceTimersByTimeAsync(70_000);
      expect(socket.closeCalls.at(-1)).toEqual([4000, 'liveness timeout']);
      await connected;
    } finally {
      jest.useRealTimers();
    }
  });

  it('rides ONE Binance socket for kline_5m and trade when matching is on', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    try {
      const socket = new FakeSocket();
      const fixture = setup(() => socket);
      fixture.routes.claimProvider('binance', 'live_candle_supervisor');
      const context = ownerContext();
      fixture.routes.beginConnection({
        provider: 'binance',
        source: 'live_candle_supervisor',
        generation: context.connectionGeneration,
      });
      const connected = connectBinance(fixture.service, context);
      socket.open();
      await new Promise((resolve) => setImmediate(resolve));

      // One socket, one SUBSCRIBE, both stream families.
      expect(fixture.factory).toHaveBeenCalledTimes(1);
      expect(socket.sent).toHaveLength(1);
      expect(JSON.parse(socket.sent[0])).toEqual({
        method: 'SUBSCRIBE',
        params: ['btcusdt@kline_5m', 'btcusdt@trade'],
        id: 1,
      });

      // The batch ack activates the subscription for readiness.
      socket.emit('message', JSON.stringify({ result: null, id: 1 }));
      expect(
        fixture.routes.checkAssetReadiness({
          assetId: 'btc',
          provider: 'binance',
          livenessMaxAgeMs: 600_000,
        }),
      ).toMatchObject({ ready: true });

      socket.emit('message', binanceTradeFrame());
      socket.emit('message', binanceFrame());
      await Promise.resolve();
      socket.close(1000, 'fixture done');
      await connected;
      await Promise.resolve();

      // kline -> candle pipeline, trade -> matcher; never crossed over.
      expect(fixture.pipeline.process).toHaveBeenCalledTimes(1);
      expect(fixture.publishedTrades).toHaveLength(1);
      expect(fixture.publishedTrades[0]).toMatchObject({
        provider: 'binance',
        assetId: 'btc',
        price: '99.50000000',
        sourceName: 'binance_spot_ws_trade',
        providerEventId: '4242',
        asset: {
          assetId: 'btc',
          settlementCurrency: 'USD',
          generation: context.connectionGeneration,
        },
      });
    } finally {
      delete process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;
    }
  });

  it('subscribes klines only and publishes no trade when matching is off', async () => {
    const socket = new FakeSocket();
    const fixture = setup(() => socket);
    fixture.routes.claimProvider('binance', 'live_candle_supervisor');
    const context = ownerContext();
    const connected = connectBinance(fixture.service, context);
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('message', JSON.stringify({ result: null, id: 1 }));
    socket.emit('message', binanceTradeFrame());
    await Promise.resolve();
    socket.close(1000, 'fixture done');
    await connected;

    expect((JSON.parse(socket.sent[0]) as { params: string[] }).params).toEqual(
      ['btcusdt@kline_5m'],
    );
    expect(fixture.publishedTrades).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Binance subscription cap — counted in STREAMS, which is what Binance limits
  // -------------------------------------------------------------------------
  // An asset costs ONE stream with the matcher off and TWO with it on
  // (`@kline_5m` + `@trade`). An asset-count cap of 1024 would therefore
  // silently request 2048 streams, and Binance rejects the whole SUBSCRIBE —
  // the connection then carries no market data at all.

  async function subscribeParams(input: {
    assets: Array<ReturnType<typeof cryptoAsset>>;
    maxAssets?: number;
    maxStreams?: number;
    matching: boolean;
  }): Promise<string[]> {
    if (input.matching) {
      process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    }
    try {
      const socket = new FakeSocket();
      const fixture = setup(
        () => socket,
        input.assets,
        input.maxAssets ?? 2000,
        input.maxStreams === undefined
          ? {}
          : { maxProviderStreamsPerShard: input.maxStreams },
      );
      fixture.routes.claimProvider('binance', 'live_candle_supervisor');
      const context = ownerContext();
      fixture.routes.beginConnection({
        provider: 'binance',
        source: 'live_candle_supervisor',
        generation: context.connectionGeneration,
      });
      const connected = connectBinance(fixture.service, context);
      socket.open();
      await new Promise((resolve) => setImmediate(resolve));
      const params = (JSON.parse(socket.sent[0]) as { params: string[] })
        .params;
      socket.close(1000, 'fixture done');
      await connected;
      return params;
    } finally {
      if (input.matching) delete process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;
    }
  }

  function cryptoAssets(count: number) {
    return Array.from({ length: count }, (_unused, index) =>
      cryptoAsset(`a${index}`, `SYM${index}`),
    );
  }

  it('costs one stream per asset while matching is off', async () => {
    const params = await subscribeParams({
      assets: cryptoAssets(10),
      matching: false,
    });
    expect(params).toHaveLength(10);
    expect(
      params.filter((stream) => stream.endsWith('@kline_5m')),
    ).toHaveLength(10);
    expect(params.filter((stream) => stream.endsWith('@trade'))).toHaveLength(
      0,
    );
  });

  it('costs two streams per asset while matching is on', async () => {
    const params = await subscribeParams({
      assets: cryptoAssets(10),
      matching: true,
    });
    expect(params).toHaveLength(20);
    expect(
      params.filter((stream) => stream.endsWith('@kline_5m')),
    ).toHaveLength(10);
    expect(params.filter((stream) => stream.endsWith('@trade'))).toHaveLength(
      10,
    );
    // kline and trade for one asset must stay on the SAME socket.
    expect(params).toContain('sym0usdt@kline_5m');
    expect(params).toContain('sym0usdt@trade');
  });

  it('derives the asset budget from the stream budget when matching is on', async () => {
    // 7 streams / 2 per asset = 3 assets, and the 4th is capped.
    const params = await subscribeParams({
      assets: cryptoAssets(10),
      maxStreams: 7,
      matching: true,
    });
    expect(params).toHaveLength(6);
    expect(params).toContain('sym2usdt@trade');
    expect(params).not.toContain('sym3usdt@kline_5m');
  });

  it('never exceeds the 1024-stream connection limit at the boundary', async () => {
    // 512 assets x 2 streams is EXACTLY the limit; nothing may be dropped and
    // nothing may spill over.
    const params = await subscribeParams({
      assets: cryptoAssets(512),
      maxStreams: 1024,
      matching: true,
    });
    expect(params).toHaveLength(1024);
  });

  it('caps assets rather than sending more than 1024 streams', async () => {
    // 600 assets would be 1200 streams under an asset-count cap. The stream
    // budget must win.
    const params = await subscribeParams({
      assets: cryptoAssets(600),
      maxStreams: 1024,
      matching: true,
    });
    expect(params).toHaveLength(1024);
    expect(params.length).toBeLessThanOrEqual(1024);
  });

  it('marks a stream-capped asset as not subscribed for readiness', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    try {
      const socket = new FakeSocket();
      const fixture = setup(() => socket, cryptoAssets(4), 2000, {
        maxProviderStreamsPerShard: 4,
      });
      fixture.routes.claimProvider('binance', 'live_candle_supervisor');
      const context = ownerContext();
      fixture.routes.beginConnection({
        provider: 'binance',
        source: 'live_candle_supervisor',
        generation: context.connectionGeneration,
      });
      const connected = connectBinance(fixture.service, context);
      socket.open();
      await new Promise((resolve) => setImmediate(resolve));
      socket.emit('message', JSON.stringify({ result: null, id: 1 }));

      // 4 streams / 2 = 2 subscribed assets; a2 and a3 are capped.
      expect(
        fixture.routes.checkAssetReadiness({
          assetId: 'a1',
          provider: 'binance',
          livenessMaxAgeMs: 600_000,
        }),
      ).toMatchObject({ ready: true });
      const capped = fixture.routes.checkAssetReadiness({
        assetId: 'a3',
        provider: 'binance',
        livenessMaxAgeMs: 600_000,
      });
      expect(capped).toMatchObject({
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
      });
      expect(!capped.ready && capped.reason).toContain('shard cap');

      socket.close(1000, 'fixture done');
      await connected;
    } finally {
      delete process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;
    }
  });

  it('recomputes the cap and the generation after a reconnect', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    try {
      const assets = cryptoAssets(4);
      const first = await subscribeParams({
        assets,
        maxStreams: 4,
        matching: true,
      });
      expect(first).toHaveLength(4);

      // A reconnect on the same process re-derives the budget from scratch and
      // starts a NEW generation, so no readiness survives from the old one.
      // The matcher flag is re-set because `subscribeParams` clears it on the
      // way out, and the supervisor reads the matching config at construction.
      process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
      const socket = new FakeSocket();
      const fixture = setup(() => socket, assets, 2000, {
        maxProviderStreamsPerShard: 8,
      });
      fixture.routes.claimProvider('binance', 'live_candle_supervisor');
      const context = ownerContext();
      fixture.routes.beginConnection({
        provider: 'binance',
        source: 'live_candle_supervisor',
        generation: context.connectionGeneration,
      });
      const connected = connectBinance(fixture.service, context);
      socket.open();
      await new Promise((resolve) => setImmediate(resolve));
      const second = (JSON.parse(socket.sent[0]) as { params: string[] })
        .params;
      expect(second).toHaveLength(8);
      expect(
        fixture.routes.checkAssetReadiness({
          assetId: 'a3',
          provider: 'binance',
          livenessMaxAgeMs: 600_000,
          // Not acknowledged yet on the NEW generation.
        }),
      ).toMatchObject({ ready: false });
      socket.close(1000, 'fixture done');
      await connected;
    } finally {
      delete process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;
    }
  });

  it('publishes a KIS exact trade from the SAME parsed frame as the candle', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    try {
      const socket = new FakeSocket();
      const fixture = setup(() => socket, [domesticAsset('sam', '005930')]);
      await Promise.resolve();
      fixture.routes.claimProvider('kis', 'live_candle_supervisor');
      const context = { ...ownerContext(), provider: 'kis' as const };
      fixture.routes.beginConnection({
        provider: 'kis',
        source: 'live_candle_supervisor',
        generation: context.connectionGeneration,
      });
      const connected = connectKis(fixture.service, context);
      socket.open();
      await new Promise((resolve) => setImmediate(resolve));

      // Only ONE KIS socket exists for both consumers.
      expect(fixture.factory).toHaveBeenCalledTimes(1);
      expect(fixture.factory).toHaveBeenCalledWith('wss://kis.example');

      socket.emit('message', kisAckFrame('005930'));
      expect(
        fixture.routes.checkAssetReadiness({
          assetId: 'sam',
          provider: 'kis',
          livenessMaxAgeMs: 600_000,
        }),
      ).toMatchObject({ ready: true });

      socket.emit('message', kisTradeFrame());
      await Promise.resolve();
      socket.close(1000, 'fixture done');
      await connected;
      await Promise.resolve();

      expect(fixture.pipeline.process).toHaveBeenCalledTimes(1);
      expect(fixture.publishedTrades).toHaveLength(1);
      expect(fixture.publishedTrades[0]).toMatchObject({
        provider: 'kis',
        assetId: 'sam',
        sourceName: 'kis_krx_realtime_trade',
        asset: { assetId: 'sam', settlementCurrency: 'KRW' },
      });
    } finally {
      delete process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;
    }
  });

  it('does not publish trades for an asset outside the current generation', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    try {
      const socket = new FakeSocket();
      const fixture = setup(() => socket);
      fixture.routes.claimProvider('binance', 'live_candle_supervisor');
      const context = ownerContext();
      const connected = connectBinance(fixture.service, context);
      socket.open();
      await new Promise((resolve) => setImmediate(resolve));
      // Reconnect invalidates the registration made above.
      fixture.routes.beginConnection({
        provider: 'binance',
        source: 'live_candle_supervisor',
        generation: 'other-generation',
      });
      socket.emit('message', binanceTradeFrame());
      await Promise.resolve();
      socket.close(1000, 'fixture done');
      await connected;

      expect(fixture.publishedTrades).toHaveLength(0);
    } finally {
      delete process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;
    }
  });

  it('closes the provider socket immediately after owner lease renewal is lost', async () => {
    jest.useFakeTimers();
    const socket = new FakeSocket();
    const fixture = setup(() => socket);
    fixture.locks.extend.mockResolvedValue(false);
    const context = ownerContext(socket);
    startLeaseRenewal(fixture.service, context);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(context.lost).toBe(true);
    expect(socket.closeCalls.at(-1)).toEqual([4003, 'owner lease lost']);
    if (context.renewTimer) clearInterval(context.renewTimer);
    jest.useRealTimers();
  });
});

function setup(
  socketFactory: () => FakeSocket,
  assets = [cryptoAsset('btc', 'BTC')],
  maxProviderSubscriptionsPerShard = 200,
  configOverrides: Record<string, unknown> = {},
) {
  const prisma = {
    asset: {
      findMany: jest.fn().mockResolvedValue(assets),
    },
  };
  const routes = new ProviderTradeRouteRegistry();
  const tradeBus = new NormalizedProviderTradeEventBus();
  const publishedTrades: unknown[] = [];
  tradeBus.subscribe((tick) => {
    publishedTrades.push(tick);
  });
  const locks = {
    acquire: jest.fn(),
    extend: jest.fn().mockResolvedValue(true),
    release: jest.fn(),
  };
  const providerConfig = {
    getConfig: jest.fn().mockReturnValue({
      common: { providerIngestionEnabled: true },
      binance: {
        enabled: true,
        wsMarketDataBaseUrl: 'wss://stream.example',
      },
      kis: {
        enabled: true,
        wsBaseUrl: 'wss://kis.example',
        wsDomesticTrId: 'H0STCNT0',
        wsOverseasDelayedTrId: 'HDFSCNT0',
        wsCustType: 'P',
      },
    }),
  };
  const kisAuth = {
    requestConfiguredWebSocketApprovalKey: jest.fn().mockResolvedValue({
      state: 'available',
      response: { approvalKey: 'approval-key' },
    }),
  };
  const normalizer = {
    normalizeBinance: jest.fn().mockReturnValue({
      price: '105.00000000',
      source: 'binance_spot_ws_5m_kline',
      eventTime: new Date(299_000),
      receivedAt: new Date(300_000),
    }),
    normalizeKis: jest.fn().mockReturnValue({
      price: '71000.00000000',
      source: 'kis_krx_realtime_trade',
      eventTime: new Date(299_000),
      receivedAt: new Date(300_000),
    }),
  };
  const pipeline = {
    markProviderConnected: jest.fn(),
    markProviderContinuityLost: jest.fn().mockResolvedValue(undefined),
    process: jest.fn().mockResolvedValue({ status: 'updated' }),
  };
  const pricePubSub = { publish: jest.fn().mockResolvedValue(true) };
  const health = new LiveCandleHealthService();
  const factory = jest.fn(socketFactory);
  const service = new LiveCandleStreamSupervisorService(
    prisma as never,
    locks as never,
    providerConfig as never,
    kisAuth as never,
    pricePubSub as never,
    normalizer as never,
    pipeline as never,
    health,
    routes,
    tradeBus,
    {
      ...readLiveCandleConfig({}),
      enabled: true,
      binanceEnabled: true,
      kisEnabled: true,
      maxProviderSubscriptionsPerShard,
      ...configOverrides,
    },
    factory,
  );
  return {
    service,
    locks,
    pipeline,
    pricePubSub,
    health,
    factory,
    routes,
    tradeBus,
    publishedTrades,
  };
}

function cryptoAsset(id: string, symbol: string) {
  return {
    id,
    symbol,
    assetType: 'crypto',
    market: 'BINANCE',
    isActive: true,
    settlementCurrency: 'USD',
  };
}

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  pong = jest.fn();

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push([code, reason]);
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

function ownerContext(socket: FakeSocket | null = null) {
  return {
    provider: 'binance' as const,
    lock: { key: 'lease', token: 'owner-1' },
    leaseKey: 'lease',
    lost: false,
    socket,
    renewTimer: null as NodeJS.Timeout | null,
    connectionGeneration: 'owner-1:conn-1',
  };
}

function connectBinance(
  service: LiveCandleStreamSupervisorService,
  context: ReturnType<typeof ownerContext>,
) {
  return (
    service as unknown as {
      connectBinance(context: unknown): Promise<void>;
    }
  ).connectBinance(context);
}

function connectKis(
  service: LiveCandleStreamSupervisorService,
  context: ReturnType<typeof ownerContext>,
) {
  return (
    service as unknown as {
      connectKis(context: unknown): Promise<void>;
    }
  ).connectKis(context);
}

function startLeaseRenewal(
  service: LiveCandleStreamSupervisorService,
  context: ReturnType<typeof ownerContext>,
) {
  return (
    service as unknown as {
      startLeaseRenewal(context: unknown): void;
    }
  ).startLeaseRenewal(context);
}

function domesticAsset(id: string, symbol: string) {
  return {
    id,
    symbol,
    assetType: 'domestic_stock',
    market: 'KRX',
    isActive: true,
    settlementCurrency: 'KRW',
  };
}

function binanceTradeFrame(): string {
  return JSON.stringify({
    e: 'trade',
    E: 299_500,
    s: 'BTCUSDT',
    t: 4242,
    p: '99.5',
    q: '0.1',
    T: 299_400,
    m: false,
  });
}

function kisAckFrame(trKey: string): string {
  return JSON.stringify({
    header: { tr_id: 'H0STCNT0', tr_key: trKey },
    body: { rt_cd: '0', msg_cd: 'OPSP0000', msg1: 'SUBSCRIBE SUCCESS' },
  });
}

function kisTradeFrame(): string {
  // Official KIS pipe-delimited realtime frame: 0|<tr_id>|<count>|<fields>
  const fields = Array.from({ length: 46 }, () => '');
  fields[0] = '005930';
  fields[1] = '090000';
  fields[2] = '71000';
  fields[12] = '10';
  fields[13] = '1000';
  fields[14] = '71000000';
  fields[33] = '20260722';
  return `0|H0STCNT0|001|${fields.join('^')}`;
}

function binanceFrame(): string {
  return JSON.stringify({
    e: 'kline',
    E: 299_000,
    s: 'BTCUSDT',
    k: {
      t: 0,
      T: 299_999,
      s: 'BTCUSDT',
      i: '5m',
      f: 1,
      L: 2,
      o: '100',
      h: '110',
      l: '90',
      c: '105',
      v: '10',
      n: 2,
      x: false,
      q: '1050',
    },
  });
}
