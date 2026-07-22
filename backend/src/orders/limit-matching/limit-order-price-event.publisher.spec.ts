jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
  };
});
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { AssetType, CurrencyCode } from '../../generated/prisma/client';
import { NormalizedProviderTradeEventBus } from '../../providers/normalized-provider-trade-event-bus.service';
import { ProviderTradeRouteRegistry } from '../../providers/provider-trade-route.registry';
import type { RedisService } from '../../redis/redis.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { LimitOrderPriceEventPublisher } from './limit-order-price-event.publisher';
import type { LimitOrderMatcherHealthService } from './limit-order-matcher-health.service';

describe('LimitOrderPriceEventPublisher', () => {
  const originalFlag = process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;
    } else {
      process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = originalFlag;
    }
    jest.restoreAllMocks();
  });

  it.each([
    ['kis', 'KRX', AssetType.domestic_stock, CurrencyCode.KRW],
    ['binance', 'BINANCE', AssetType.crypto, CurrencyCode.USD],
  ] as const)(
    'writes a secret-free normalized %s trade to the Redis Stream',
    async (provider, market, assetType, currencyCode) => {
      process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
      const prisma = {
        asset: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'asset-1',
            symbol: provider === 'kis' ? '005930' : 'BTC',
            market,
            assetType,
            currencyCode,
            settlementCurrency: currencyCode,
            isActive: true,
          }),
        },
      } as unknown as PrismaService;
      const xadd = jest.fn().mockResolvedValue('100-1');
      const redis = { xadd } as unknown as RedisService;
      const bus = new NormalizedProviderTradeEventBus();
      const health = {
        degradeActiveLeader: jest.fn(),
      } as unknown as LimitOrderMatcherHealthService;
      const publisher = new LimitOrderPriceEventPublisher(
        prisma,
        redis,
        bus,
        health,
        new ProviderTradeRouteRegistry(),
      );
      publisher.onModuleInit();

      bus.publish({
        provider,
        providerEventId: 'trade-7',
        providerSequence: '7',
        providerConnectionId: 'generation-2',
        assetId: 'asset-1',
        symbol: provider === 'kis' ? '005930' : 'BTCUSDT',
        providerSymbol: provider === 'kis' ? '005930' : 'BTCUSDT',
        price: '90',
        currencyCode,
        providerEventAt: '2026-07-22T01:00:00.000Z',
        receivedAt: '2026-07-22T01:00:00.010Z',
        sourceName:
          provider === 'kis'
            ? 'kis_krx_realtime_trade'
            : 'binance_spot_ws_trade',
        marketSessionCode: provider === 'kis' ? 'regular' : null,
        eventType: 'trade',
      });
      await flushAsync();

      expect(xadd).toHaveBeenCalledTimes(1);
      const [, fields] = xadd.mock.calls[0] as [
        string,
        { eventId: string; payload: string },
        number,
      ];
      expect(fields.eventId).toBe(`${provider}:asset-1:trade-7`);
      const payload = JSON.parse(fields.payload) as Record<string, unknown>;
      expect(payload).toMatchObject({
        schemaVersion: 1,
        eventType: 'trade',
        provider,
        assetId: 'asset-1',
        price: '90.00000000',
      });
      expect(fields.payload).not.toMatch(
        /rawPayload|authorization|appKey|secret|token/iu,
      );
      await publisher.onModuleDestroy();
    },
  );

  it('does not subscribe or write when automatic matching is disabled', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'false';
    const findUnique = jest.fn();
    const prisma = {
      asset: { findUnique },
    } as unknown as PrismaService;
    const xadd = jest.fn();
    const redis = { xadd } as unknown as RedisService;
    const bus = new NormalizedProviderTradeEventBus();
    const health = {
      degradeActiveLeader: jest.fn(),
    } as unknown as LimitOrderMatcherHealthService;
    const publisher = new LimitOrderPriceEventPublisher(
      prisma,
      redis,
      bus,
      health,
      new ProviderTradeRouteRegistry(),
    );
    publisher.onModuleInit();

    bus.publish({
      provider: 'binance',
      providerEventId: 'trade-disabled',
      providerSequence: '1',
      providerConnectionId: null,
      assetId: 'asset-1',
      symbol: 'BTCUSDT',
      providerSymbol: 'BTCUSDT',
      price: '1',
      currencyCode: CurrencyCode.USD,
      providerEventAt: '2026-07-22T01:00:00.000Z',
      receivedAt: '2026-07-22T01:00:00.001Z',
      sourceName: 'binance_spot_ws_trade',
      marketSessionCode: null,
      eventType: 'trade',
    });
    await flushAsync();

    expect(findUnique).not.toHaveBeenCalled();
    expect(xadd).not.toHaveBeenCalled();
  });

  it('preserves provider arrival order while an earlier XADD is still pending', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const prisma = {
      asset: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asset-1',
          symbol: 'BTC',
          market: 'BINANCE',
          assetType: AssetType.crypto,
          currencyCode: CurrencyCode.USD,
          settlementCurrency: CurrencyCode.USD,
          isActive: true,
        }),
      },
    } as unknown as PrismaService;
    let releaseFirst: (streamId: string) => void = () => undefined;
    const firstXadd = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const xadd = jest
      .fn()
      .mockImplementationOnce(() => firstXadd)
      .mockResolvedValueOnce('100-2');
    const bus = new NormalizedProviderTradeEventBus();
    const publisher = new LimitOrderPriceEventPublisher(
      prisma,
      { xadd } as unknown as RedisService,
      bus,
      {
        degradeActiveLeader: jest.fn(),
      } as unknown as LimitOrderMatcherHealthService,
      new ProviderTradeRouteRegistry(),
    );
    publisher.onModuleInit();

    for (const providerEventId of ['trade-1', 'trade-2']) {
      bus.publish({
        provider: 'binance',
        providerEventId,
        providerSequence: providerEventId,
        providerConnectionId: 'generation-1',
        assetId: 'asset-1',
        symbol: 'BTCUSDT',
        providerSymbol: 'BTCUSDT',
        price: '100',
        currencyCode: CurrencyCode.USD,
        providerEventAt: '2026-07-22T01:00:00.000Z',
        receivedAt: '2026-07-22T01:00:00.001Z',
        sourceName: 'binance_spot_ws_trade',
        marketSessionCode: null,
        eventType: 'trade',
      });
    }

    await flushAsync();
    expect(xadd).toHaveBeenCalledTimes(1);
    releaseFirst('100-1');
    await publisher.onModuleDestroy();

    expect(xadd).toHaveBeenCalledTimes(2);
    const eventIds = xadd.mock.calls.map(
      (call: [string, { eventId: string }]) => call[1].eventId,
    );
    expect(eventIds).toEqual([
      'binance:asset-1:trade-1',
      'binance:asset-1:trade-2',
    ]);
  });

  it('marks the DB matcher health degraded when XADD fails', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const prisma = {
      asset: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asset-1',
          symbol: 'BTC',
          market: 'BINANCE',
          assetType: AssetType.crypto,
          currencyCode: CurrencyCode.USD,
          settlementCurrency: CurrencyCode.USD,
          isActive: true,
        }),
      },
    } as unknown as PrismaService;
    const redis = {
      xadd: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as RedisService;
    const degradeActiveLeader = jest.fn().mockResolvedValue(undefined);
    const health = {
      degradeActiveLeader,
    } as unknown as LimitOrderMatcherHealthService;
    const publisher = new LimitOrderPriceEventPublisher(
      prisma,
      redis,
      new NormalizedProviderTradeEventBus(),
      health,
      new ProviderTradeRouteRegistry(),
    );

    await expect(
      publisher.publish({
        provider: 'binance',
        providerEventId: 'failed-trade',
        providerSequence: '1',
        providerConnectionId: null,
        assetId: 'asset-1',
        symbol: 'BTCUSDT',
        providerSymbol: 'BTCUSDT',
        price: '100',
        currencyCode: CurrencyCode.USD,
        providerEventAt: '2026-07-22T01:00:00.000Z',
        receivedAt: '2026-07-22T01:00:00.001Z',
        sourceName: 'binance_spot_ws_trade',
        marketSessionCode: null,
        eventType: 'trade',
      }),
    ).rejects.toThrow('redis unavailable');
    expect(degradeActiveLeader).toHaveBeenCalledWith(
      'LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE',
      expect.any(String),
    );
  });

  it('rejects a malformed normalized tick before writing to Redis', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const prisma = {
      asset: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asset-1',
          symbol: 'BTC',
          market: 'BINANCE',
          assetType: AssetType.crypto,
          currencyCode: CurrencyCode.USD,
          settlementCurrency: CurrencyCode.USD,
          isActive: true,
        }),
      },
    } as unknown as PrismaService;
    const xadd = jest.fn();
    const publisher = new LimitOrderPriceEventPublisher(
      prisma,
      { xadd } as unknown as RedisService,
      new NormalizedProviderTradeEventBus(),
      {
        degradeActiveLeader: jest.fn(),
      } as unknown as LimitOrderMatcherHealthService,
      new ProviderTradeRouteRegistry(),
    );

    await expect(
      publisher.publish({
        provider: 'binance',
        providerEventId: 'malformed',
        providerSequence: '1',
        providerConnectionId: null,
        assetId: 'asset-1',
        symbol: 'BTCUSDT',
        providerSymbol: 'BTCUSDT',
        price: '0',
        currencyCode: CurrencyCode.USD,
        providerEventAt: '2026-07-22T01:00:00.000Z',
        receivedAt: '2026-07-22T01:00:00.001Z',
        sourceName: 'binance_spot_ws_trade',
        marketSessionCode: null,
        eventType: 'trade',
      }),
    ).rejects.toThrow('positive');
    expect(xadd).not.toHaveBeenCalled();
  });
});

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
