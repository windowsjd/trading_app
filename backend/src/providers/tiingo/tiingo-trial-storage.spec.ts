jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
  };
});

/**
 * Trial storage policy (Tiingo ToS §1.6(a)): the whole trial flow — stream
 * ticks, REST fallback, asset reads, sorted lists and candle reads — must not
 * write a single row/key. Prisma and Redis doubles record every write-capable
 * call; reads are answered from fixtures. All market data here is synthetic.
 */
import { Prisma } from '../../generated/prisma/client';
import { AssetsService } from '../../assets/assets.service';
import { CandleReadPlanBuilder } from '../../assets/candle-read-plan.builder';
import { CandleResponseBuilder } from '../../assets/candle-response.builder';
import { readCandleServingConfig } from '../../assets/candle-serving.config';
import { DailyChangeRateService } from '../../assets/daily-change-rate.service';
import { MarketCandleAggregationService } from '../../assets/market-candle-aggregation.service';
import { MarketCandlesRepository } from '../../assets/market-candles.repository';
import { TiingoCandleReaderService } from '../../assets/tiingo-candle-reader.service';
import { findPreviousMarketSession } from '../../orders/market-calendar.policy';
import { BinanceRealtimePriceEventBus } from '../binance/binance-realtime-price-event-bus.service';
import { KisRealtimePriceEventBus } from '../kis/kis-realtime-price-event-bus.service';
import { MarketDisplayPriceService } from '../market-display-price.service';
import { MarketPriceEventService } from '../market-price-event.service';
import { TiingoAssetMapService } from './tiingo-asset-map.service';
import { TiingoCandleService } from './tiingo-candle.service';
import { readTiingoConfig, TiingoConfigService } from './tiingo.config';
import { TiingoMarketDataStore } from './tiingo-market-data.store';
import { TiingoQuoteService } from './tiingo-quote.service';
import { TiingoRestClient, type TiingoFetch } from './tiingo-rest.client';
import {
  TiingoStreamService,
  type TiingoSocket,
} from './tiingo-stream.service';

const WRITE_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

const AAPL_ROW = {
  id: 'asset-aapl',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  market: 'NAS',
  assetType: 'us_stock',
  currencyCode: 'USD',
  priceCurrency: 'USD',
  settlementCurrency: 'USD',
  isActive: true,
};

function recordingPrisma() {
  const writes: string[] = [];
  const reads: Record<string, Record<string, jest.Mock>> = {
    asset: {
      findMany: jest.fn().mockResolvedValue([AAPL_ROW]),
      findUnique: jest.fn().mockResolvedValue(AAPL_ROW),
      findFirst: jest.fn().mockResolvedValue(AAPL_ROW),
      count: jest.fn().mockResolvedValue(1),
    },
    fxRateSnapshot: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 'fx-1',
            baseCurrency: 'USD',
            quoteCurrency: 'KRW',
            rate: new Prisma.Decimal('1400'),
            sourceType: 'provider_api',
            sourceName: 'korea_exim_exchange_rate',
            effectiveAt: new Date(Date.now() - 1_000),
            capturedAt: new Date(Date.now() - 1_000),
            createdAt: new Date(Date.now() - 1_000),
            approvedByUserId: null,
          },
        ]),
      ),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    assetPriceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    marketCandle: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => {
          if (WRITE_METHODS.includes(method))
            return (...args: unknown[]) => {
              writes.push(`${name}.${method}`);
              void args;
              return Promise.resolve(null);
            };
          return reads[name]?.[method] ?? jest.fn().mockResolvedValue(null);
        },
      },
    );
  const prisma = new Proxy(
    {},
    {
      get: (_target, key: string) => {
        if (key.startsWith('$'))
          return () => {
            writes.push(key);
            return Promise.resolve(null);
          };
        return model(key);
      },
    },
  );
  return { prisma, writes, reads };
}

function recordingRedis() {
  const writes: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      writes.push(name);
      void args;
      return Promise.resolve(null);
    };
  return {
    writes,
    redis: {
      get: jest.fn().mockResolvedValue(null),
      eval: record('eval'),
      set: record('set'),
      setWithTtl: record('setWithTtl'),
      publish: record('publish'),
      increment: record('increment'),
      delete: record('delete'),
    },
  };
}

class FakeSocket implements TiingoSocket {
  readyState = 0;
  private readonly listeners = new Map<string, ((...args: any[]) => void)[]>();
  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  removeAllListeners() {
    this.listeners.clear();
    return this;
  }
  send() {}
  close() {}
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function syntheticFetch(): TiingoFetch {
  return (url) => {
    const parsed = new URL(url);
    if (
      parsed.pathname.endsWith('/prices') &&
      parsed.pathname.includes('/intraday/')
    ) {
      const start = parsed.searchParams.get('startDate')!;
      const end = parsed.searchParams.get('endDate')!;
      const bars: Record<string, unknown>[] = [];
      for (
        let day = Date.parse(`${start}T13:30:00.000Z`);
        day <= Date.parse(`${end}T13:30:00.000Z`);
        day += 86_400_000
      ) {
        const weekday = new Date(day).getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        for (let slot = 0; slot < 78; slot += 1)
          bars.push({
            date: new Date(day + slot * 300_000).toISOString(),
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 10,
          });
      }
      return Promise.resolve(
        new Response(JSON.stringify(bars), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify([
          {
            ticker: 'AAPL',
            timestamp: '2026-10-13T10:29:59.000000001-04:00',
            tngoLast: 247.5,
            lqBidPrice: 247.45,
            lqBidSize: 300,
            lqAskPrice: 247.55,
            lqAskSize: 200,
            lqSpread: 0.0004,
          },
        ]),
        { status: 200 },
      ),
    );
  };
}

describe('Tiingo trial storage policy', () => {
  const previousRedisUrl = process.env.REDIS_URL;
  beforeEach(() => {
    jest.useFakeTimers();
    // Tue 2026-10-13 10:30 ET — regular session.
    jest.setSystemTime(new Date('2026-10-13T14:30:00.000Z'));
    process.env.REDIS_URL = 'redis://fixture.invalid';
  });
  afterEach(() => {
    jest.useRealTimers();
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  });

  it('serves stream ticks, prices, sorted lists and candles without any write', async () => {
    const { prisma, writes: prismaWrites } = recordingPrisma();
    const { redis, writes: redisWrites } = recordingRedis();
    const config = new TiingoConfigService(
      readTiingoConfig({
        TIINGO_ENABLED: 'true',
        TIINGO_API_TOKEN: 'synthetic-token',
        TIINGO_ALLOWED_SYMBOLS: 'AAPL',
      }),
    );
    const rest = new TiingoRestClient(config, {
      fetch: syntheticFetch(),
      sleep: () => Promise.resolve(),
    });
    const store = new TiingoMarketDataStore();
    const assetMap = new TiingoAssetMapService(prisma as never, config);
    const sockets: FakeSocket[] = [];
    const stream = new TiingoStreamService(config, assetMap, store, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const events = new MarketPriceEventService(
      new KisRealtimePriceEventBus(),
      new BinanceRealtimePriceEventBus(),
    );
    const published: unknown[] = [];
    events.subscribe((event) => {
      published.push(event);
    });
    const quotes = new TiingoQuoteService(
      config,
      assetMap,
      rest,
      store,
      events,
      stream,
    );
    quotes.onModuleInit();
    const candles = new TiingoCandleService(rest);
    const assets = new AssetsService(
      prisma as never,
      undefined,
      new DailyChangeRateService(new MarketCandlesRepository(prisma as never)),
      redis as never,
      new MarketDisplayPriceService(quotes),
    );
    const reader = new TiingoCandleReaderService(
      quotes,
      candles,
      new CandleReadPlanBuilder(readCandleServingConfig({})),
      new MarketCandleAggregationService({} as never),
      new CandleResponseBuilder(),
    );

    // 1) Stream tick → in-process event only.
    await stream.start();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          messageType: 'I',
          data: { subscriptionId: 1 },
          response: { code: 200 },
        }),
      ),
    );
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          messageType: 'A',
          service: 'cons',
          data: ['2026-10-13T10:29:59.5-04:00', 'aapl', 247.61],
        }),
      ),
    );
    // MarketPriceEventService delivers to listeners in a microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toHaveLength(1);

    // 2) Asset detail and a sorted list.
    const detail = await assets.getAsset('user-1', 'asset-aapl');
    expect(detail.data.asset.price).toMatchObject({
      state: 'available',
      currentPrice: '247.61000000',
      assetPriceSnapshotId: null,
    });
    await assets.getAssets('user-1', { sortBy: 'turnover', limit: '10' });

    // 3) Candles: 96-session 4h window and a 5m window.
    const now = new Date();
    const anchor = findPreviousMarketSession(AAPL_ROW as never, now, 96)!;
    const query = (interval: '4h' | '5m', from: Date) => ({
      range: '96d' as const,
      rangeProvided: true,
      rangeStartAt: from,
      rangeEndAt: now,
      interval,
      intervalMinutes: interval === '4h' ? 240 : 5,
      limit: 600,
      requestedDate: '2026-10-13',
      toHHmmss: '103000',
      toInstant: now,
      dateProvided: true,
      toProvided: true,
      includePrevious: true,
      explicitDate: false,
      explicitTo: false,
      clock: now,
    });
    const long = await reader.read(
      AAPL_ROW as never,
      { assetId: 'asset-aapl', symbol: 'AAPL', market: 'NAS', ticker: 'aapl' },
      query('4h', anchor.openTime),
    );
    expect(long.response.data.candles.length).toBeGreaterThan(100);
    await reader.read(
      AAPL_ROW as never,
      { assetId: 'asset-aapl', symbol: 'AAPL', market: 'NAS', ticker: 'aapl' },
      query('5m', new Date('2026-10-13T13:30:00.000Z')),
    );

    expect(prismaWrites).toEqual([]);
    expect(redisWrites).toEqual([]);
    await stream.stop();
    quotes.onModuleDestroy();
    store.onModuleDestroy();
    candles.onModuleDestroy();
    expect(store.latestReference('AAPL')).toBeNull();
    expect(candles.getStatus().cachedSessions).toBe(0);
  });
});
