jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      provider_api: 'provider_api',
    },
    AssetType: {
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      provider_api: 'provider_api',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import { Prisma } from '../../generated/prisma/client';
import type { ProviderConfigService } from '../provider-config.service';
import { parseBinanceWebSocketMessage } from './binance-websocket.parser';
import { BinanceWebSocketIngestionService } from './binance-websocket.ingestion.service';
import { readAssetListTurnover } from '../../assets/asset-list-turnover';

describe('Binance WebSocket ingestion service', () => {
  const receivedAt = new Date('2026-06-19T03:00:30.000Z');

  it('creates provider_api USD snapshots with Binance WebSocket source metadata', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
      fxRate: '1400.00000000',
    });
    const service = createService({ prisma });
    const message = tickerMessage({
      symbol: 'BTCUSDT',
      price: '100.00000000',
      receivedAt,
    });

    const result = await service.ingestParsedMessage(message, {
      requestedBy: 'binance-stream-test',
    });

    expect(result).toMatchObject({
      success: true,
      provider: 'binance',
      received: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      tickers: [
        {
          symbol: 'BTCUSDT',
          state: 'created',
          assetId: 'asset-btc',
          price: '100.00000000',
        },
      ],
    });
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: 'asset-btc',
          price: '100.00000000',
          priceKrw: '140000.00000000',
          currencyCode: 'USD',
          sourceType: 'provider_api',
          sourceName: 'binance_spot_ws_ticker',
          capturedAt: receivedAt,
          effectiveAt: new Date('2026-06-19T03:00:28.000Z'),
          note: 'provider_api Binance WebSocket ticker ingestion requested by binance-stream-test',
        }),
      }),
    );
    expect(
      JSON.stringify(
        prisma.assetPriceSnapshot.create.mock.calls[0][0].data.rawPayloadJson,
      ),
    ).not.toMatch(/api[-_]?key|secret|signature/i);
    const snapshot = prisma.assetPriceSnapshot.create.mock.calls[0][0].data;
    expect(snapshot.rawPayloadJson).toEqual({
      truncated: false,
      payload: {
        provider: 'binance',
        messageType: 'spot_ws_ticker',
        streamName: 'btcusdt@ticker',
        payload: message.ticker.rawPayload,
      },
    });
    expect(snapshot.rawPayloadJson.payload.payload.data.q).toBe('999');
    expect(readAssetListTurnover(snapshot)).toEqual({
      turnover: '999',
      turnoverPeriod: 'rolling_24h',
    });
  });

  it('connects a direct ticker frame through the real parser and writer to turnover', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
    });
    const message = parseBinanceWebSocketMessage({
      frame: JSON.stringify({
        e: '24hrTicker',
        E: receivedAt.getTime(),
        s: 'BTCUSDT',
        c: '100',
        v: '123',
        q: '999',
      }),
      receivedAt,
    });
    await createService({ prisma }).ingestParsedMessage(message);
    const snapshot = prisma.assetPriceSnapshot.create.mock.calls[0][0].data;
    expect(snapshot.rawPayloadJson.payload.streamName).toBeNull();
    expect(snapshot.rawPayloadJson.payload.payload.q).toBe('999');
    expect(readAssetListTurnover(snapshot)).toEqual({
      turnover: '999',
      turnoverPeriod: 'rolling_24h',
    });
  });

  it('skips DB writes when a recent snapshot is inside the throttle window', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-eth', symbol: 'ETH' }],
      lastStored: {
        capturedAt: new Date(+receivedAt - 2000),
        effectiveAt: new Date(+receivedAt - 4000),
        price: '3499',
      },
    });
    const service = createService({ prisma });
    const message = tickerMessage({
      symbol: 'ETHUSDT',
      price: '3500.00000000',
      receivedAt,
    });

    const result = await service.ingestParsedMessage(message);

    expect(result).toMatchObject({
      success: true,
      received: 1,
      created: 0,
      skipped: 1,
      tickers: [
        {
          symbol: 'ETHUSDT',
          state: 'skipped',
          assetId: 'asset-eth',
          reason: 'THROTTLED_PROVIDER_SNAPSHOT',
        },
      ],
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('reads the last stored row once per asset, then decides every frame from memory', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
      fxRate: '1400',
    });
    const service = createService({ prisma });
    const at = (ms: number) =>
      tickerMessage({
        symbol: 'BTCUSDT',
        price: '100.00000000',
        receivedAt: new Date(+receivedAt + ms),
        eventAt: new Date(+receivedAt + ms - 100),
      });
    const reasons: Array<string | undefined> = [];
    for (const ms of [0, 1000, 4999, 5001, 6000, 10002]) {
      const result = await service.ingestParsedMessage(at(ms));
      reasons.push(result.tickers[0].reason ?? result.tickers[0].state);
    }
    expect(reasons).toEqual([
      'created',
      'THROTTLED_PROVIDER_SNAPSHOT',
      'THROTTLED_PROVIDER_SNAPSHOT',
      'created',
      'THROTTLED_PROVIDER_SNAPSHOT',
      'created',
    ]);
    // One seed read, one mapping read and one FX read for six frames.
    expect(prisma.assetPriceSnapshot.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.fxRateSnapshot.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledTimes(3);
  });

  it('rejects duplicate, out-of-order and future frames against the last stored row', async () => {
    const lastStored = {
      capturedAt: new Date(+receivedAt - 60000),
      effectiveAt: new Date('2026-06-19T03:00:28.000Z'),
      price: '100',
    };
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
      lastStored,
    });
    const service = createService({ prisma });
    const reason = async (eventAt: Date, price = '100.00000000') =>
      (
        await service.ingestParsedMessage(
          tickerMessage({ symbol: 'BTCUSDT', price, receivedAt, eventAt }),
        )
      ).tickers[0].reason;
    expect(await reason(lastStored.effectiveAt)).toBe(
      'DUPLICATE_PROVIDER_SNAPSHOT',
    );
    expect(await reason(new Date(+lastStored.effectiveAt - 1))).toBe(
      'OUT_OF_ORDER_PROVIDER_SNAPSHOT',
    );
    expect(await reason(new Date(+receivedAt + 5001))).toBe(
      'FUTURE_PROVIDER_SNAPSHOT',
    );
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('keeps no memory of a failed INSERT, so the next frame writes again', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
    });
    prisma.assetPriceSnapshot.create
      .mockRejectedValueOnce(new Error('No space left on device'))
      .mockResolvedValue({ id: 'price-2' });
    const service = createService({ prisma });
    const frame = (ms: number) =>
      tickerMessage({
        symbol: 'BTCUSDT',
        price: '100.00000000',
        receivedAt: new Date(+receivedAt + ms),
        eventAt: new Date(+receivedAt + ms - 100),
      });
    await expect(service.ingestParsedMessage(frame(0))).rejects.toThrow();
    expect(
      (await service.ingestParsedMessage(frame(1000))).tickers[0].state,
    ).toBe('created');
  });

  it('lets one of two concurrent frames of an asset write and throttles the other', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
    });
    const service = createService({ prisma });
    const frame = tickerMessage({
      symbol: 'BTCUSDT',
      price: '100.00000000',
      receivedAt,
    });
    const results = await Promise.all([
      service.ingestParsedMessage(frame),
      service.ingestParsedMessage(frame),
    ]);
    expect(
      results.map((r) => r.tickers[0].reason ?? r.tickers[0].state),
    ).toEqual(['created', 'THROTTLED_PROVIDER_SNAPSHOT']);
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledTimes(1);
  });

  it('re-reads the asset mapping after 30 s, so deactivation stops writes', async () => {
    jest.useFakeTimers({ now: receivedAt });
    try {
      const prisma = createPrismaMock({
        assets: [{ id: 'asset-btc', symbol: 'BTC' }],
      });
      const service = createService({ prisma });
      await service.ingestParsedMessage(
        tickerMessage({ symbol: 'BTCUSDT', price: '100.00000000', receivedAt }),
      );
      prisma.asset.findMany.mockResolvedValue([]);
      jest.setSystemTime(+receivedAt + 29_000);
      await service.ingestParsedMessage(
        tickerMessage({
          symbol: 'BTCUSDT',
          price: '100.00000000',
          receivedAt: new Date(+receivedAt + 29_000),
          eventAt: new Date(+receivedAt + 28_900),
        }),
      );
      expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
      jest.setSystemTime(+receivedAt + 30_001);
      const after = await service.ingestParsedMessage(
        tickerMessage({
          symbol: 'BTCUSDT',
          price: '100.00000000',
          receivedAt: new Date(+receivedAt + 40_000),
          eventAt: new Date(+receivedAt + 39_900),
        }),
      );
      expect(after.tickers[0].reason).toBe('ASSET_MAPPING_NOT_FOUND');
      expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stores the slim ticker payload without the repeated note when enabled', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
    });
    const message = tickerMessage({
      symbol: 'BTCUSDT',
      price: '100.00000000',
      receivedAt,
    });
    await createService({ prisma, rawSlim: true }).ingestParsedMessage(
      message,
      { requestedBy: 'binance-websocket-streaming' },
    );
    const snapshot = prisma.assetPriceSnapshot.create.mock.calls[0][0].data;
    expect(snapshot.note).toBeNull();
    expect(snapshot.rawPayloadJson).toEqual({
      truncated: false,
      payload: {
        provider: 'binance',
        messageType: 'spot_ws_ticker',
        streamName: 'btcusdt@ticker',
        payloadProfile: 'binance_ticker_slim_v1',
        requestedBy: 'binance-websocket-streaming',
        payload: {
          e: '24hrTicker',
          E: Date.parse('2026-06-19T03:00:28.000Z'),
          s: 'BTCUSDT',
          c: '100.00000000',
          v: '123',
          q: '999',
        },
      },
    });
    // The list turnover sort reads the same value from the slim payload.
    expect(readAssetListTurnover(snapshot)).toEqual({
      turnover: '999',
      turnoverPeriod: 'rolling_24h',
    });
    // Price, both times and the source stay in the columns.
    expect(snapshot).toMatchObject({
      price: '100.00000000',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: new Date('2026-06-19T03:00:28.000Z'),
      capturedAt: receivedAt,
    });
  });

  it('returns failed result when provider ingestion is disabled', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
    });
    const service = createService({
      prisma,
      providerIngestionEnabled: false,
    });

    const result = await service.ingestParsedMessage(
      tickerMessage({
        symbol: 'BTCUSDT',
        price: '100.00000000',
        receivedAt,
      }),
    );

    expect(result).toMatchObject({
      success: false,
      provider: 'binance',
      errorCode: 'PROVIDER_INGESTION_DISABLED',
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });
});

function tickerMessage(input: {
  symbol: string;
  price: string;
  receivedAt: Date;
  eventAt?: Date;
}) {
  const parsed = parseBinanceWebSocketMessage({
    frame: JSON.stringify({
      stream: `${input.symbol.toLowerCase()}@ticker`,
      data: {
        e: '24hrTicker',
        E: (input.eventAt ?? new Date('2026-06-19T03:00:28.000Z')).getTime(),
        s: input.symbol,
        P: '1.500',
        c: input.price,
        b: input.price,
        a: input.price,
        v: '123',
        q: '999',
      },
    }),
    receivedAt: input.receivedAt,
  });

  if (parsed.state !== 'ticker') {
    throw new Error('expected ticker message');
  }

  return parsed;
}

function createService(input: {
  prisma: ReturnType<typeof createPrismaMock>;
  providerIngestionEnabled?: boolean;
  binanceEnabled?: boolean;
  rawSlim?: boolean;
}) {
  const configService = {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: input.providerIngestionEnabled ?? true,
        httpTimeoutMs: 5000,
        rawPayloadMaxBytes: 12000,
      },
      exchangeRateApi: {
        enabled: false,
        baseUrl: 'https://example.test',
      },
      koreaEximExchange: {
        enabled: false,
        baseUrl: 'https://example.test',
        data: 'AP01',
        lookbackDays: 7,
      },
      binance: {
        enabled: input.binanceEnabled ?? true,
        restBaseUrl: 'https://api.binance.com',
        wsMarketDataBaseUrl: 'wss://stream.binance.com:9443',
        symbols: ['BTCUSDT', 'ETHUSDT'],
        usdtAsUsdEquivalent: true,
        wsStreamingEnabled: true,
        wsStreamingReconnectMinMs: 1000,
        wsStreamingReconnectMaxMs: 30000,
        wsStreamingHeartbeatTimeoutMs: 60000,
        wsSnapshotThrottleMs: 5000,
        wsRawSlimEnabled: input.rawSlim ?? false,
      },
      kis: {
        enabled: false,
        maxWatchlistSize: 41,
        domesticSymbols: [],
        usSymbols: [],
        allSymbols: [],
        canCallRestLive: false,
        canCallWebSocketLive: false,
      },
    }),
  } as unknown as ProviderConfigService;

  return new BinanceWebSocketIngestionService(
    input.prisma as never,
    configService,
  );
}

function createPrismaMock(input: {
  assets: Array<{ id: string; symbol: string }>;
  fxRate?: string;
  /** The newest stored WS row the service reads once per asset. */
  lastStored?: { capturedAt: Date; effectiveAt: Date; price: string };
}) {
  return {
    asset: {
      findMany: jest.fn().mockResolvedValue(input.assets),
    },
    assetPriceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(
        input.lastStored
          ? {
              ...input.lastStored,
              price: new Prisma.Decimal(input.lastStored.price),
            }
          : null,
      ),
      create: jest.fn().mockResolvedValue({ id: 'price-provider-1' }),
    },
    fxRateSnapshot: {
      findFirst: jest.fn().mockResolvedValue(
        input.fxRate
          ? {
              rate: new Prisma.Decimal(input.fxRate),
              effectiveAt: new Date('2026-06-19T00:00:00.000Z'),
            }
          : null,
      ),
    },
  };
}
