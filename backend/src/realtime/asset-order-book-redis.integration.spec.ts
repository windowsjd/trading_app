jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class {},
  UserStatus: { active: 'active' },
  AssetType: { crypto: 'crypto' },
  CurrencyCode: { USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
jest.mock('../assets/assets.service', () => ({ AssetsService: class {} }));
jest.mock('../assets/live-candle-overlay.service', () => ({
  LiveCandleOverlayService: class {},
}));
jest.mock('./live-candle-pubsub.service', () => ({
  LiveCandlePubSubService: class {},
}));
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import IORedis from 'ioredis';
import { RedisService } from '../redis/redis.service';
import { readRedisConfig } from '../redis/redis.config';
import {
  FUTURES_ORDER_BOOK_CHANNEL,
  OrderBookPubSubService,
  ORDER_BOOK_CHANNEL,
} from '../providers/order-book-pubsub.service';
import { FuturesMarketDataIngestion } from '../futures/futures-market-data-ingestion.service';
import { BinanceOrderBookService } from '../providers/binance/binance-order-book.service';
import { MarketOrderBookSubscriptionService } from '../providers/market-order-book-subscription.service';
import { BinanceRealtimePriceEventBus } from '../providers/binance/binance-realtime-price-event-bus.service';
import { MarketPriceEventService } from '../providers/market-price-event.service';
import { KisRealtimePriceEventBus } from '../providers/kis/kis-realtime-price-event-bus.service';
import { AssetTickerGateway } from './asset-ticker.gateway';

const redisTest = process.env.ORDER_BOOK_REDIS_SMOKE === '1' ? it : it.skip;

describe('depth -> real Redis -> separate gateway -> /api/v1/ws', () => {
  redisTest(
    'delivers and restores subscriptions without any database writes',
    async () => {
      const config = readRedisConfig();
      if (!config.url) throw new Error('Set an isolated test REDIS_URL');
      const raw = new IORedis(config.url);
      const redis = new RedisService(config);
      const publisher = new OrderBookPubSubService(redis);
      const subscriber = new OrderBookPubSubService(redis);
      const prisma = {
        asset: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'btc', symbol: 'BTCUSDT' }]),
        },
      };
      const books = new BinanceOrderBookService(prisma as never, publisher);
      const gateway = new AssetTickerGateway(
        {
          user: {
            findUnique: jest.fn().mockResolvedValue({ status: 'active' }),
          },
        } as never,
        { verifyAsync: jest.fn().mockResolvedValue({ sub: 'smoke' }) } as never,
        { get: () => 'smoke-secret' } as never,
        {} as never,
        {} as never,
        new MarketPriceEventService(
          new KisRealtimePriceEventBus(),
          new BinanceRealtimePriceEventBus(),
        ),
        undefined,
        undefined,
        undefined,
        undefined,
        subscriber,
        new MarketOrderBookSubscriptionService(books),
      );
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        path: '/api/v1/ws',
      });
      server.on('connection', (socket, request) => {
        void gateway.handleConnection(socket, request);
        socket.on('close', () => gateway.handleDisconnect(socket));
      });
      const sockets: WebSocket[] = [];
      try {
        subscriber.onModuleInit();
        gateway.onModuleInit();
        await once(server, 'listening');
        for (let attempt = 0; attempt < 100; attempt++) {
          const counts = (await raw.pubsub('NUMSUB', ORDER_BOOK_CHANNEL)) as [
            string,
            number,
          ];
          if (counts[1] > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (attempt === 99)
            throw new Error('Redis subscriber did not become ready');
        }
        const address = server.address();
        if (typeof address === 'string' || !address)
          throw new Error('Missing server address');
        const targets = await books.loadTargets();
        for (let generation = 1; generation <= 2; generation++) {
          const socket = new WebSocket(
            `ws://127.0.0.1:${address.port}/api/v1/ws?token=smoke`,
          );
          sockets.push(socket);
          await once(socket, 'open');
          const ack = nextMessage(socket);
          socket.send(
            JSON.stringify({
              type: 'subscribe',
              channel: 'asset_order_book',
              assetId: 'btc',
            }),
          );
          expect(await ack).toMatchObject({
            type: 'subscribed',
            assetId: 'btc',
          });
          const data = nextMessage(socket);
          const capturedAt = new Date();
          books.handleFrame(
            JSON.stringify({
              stream: 'btcusdt@depth10',
              data: {
                lastUpdateId: generation,
                asks: Array.from({ length: 10 }, (_, i) => [
                  `${68420 + i}.10000000`,
                  '0.00125000',
                ]),
                bids: Array.from({ length: 10 }, (_, i) => [
                  `${68419 - i}.10000000`,
                  '0.00000001',
                ]),
              },
            }),
            capturedAt,
            targets,
          );
          const received = await data;
          expect(received).toMatchObject({
            type: 'asset_order_book',
            assetId: 'btc',
            quantityUnit: 'BTC',
            priceUnit: 'USDT',
            capturedAt: capturedAt.toISOString(),
            effectiveAt: null,
          });
          expect(received.asks).toHaveLength(10);
          expect(received.bids).toHaveLength(10);
          expect(
            (received.asks as Array<{ quantity: string }>)[0].quantity,
          ).toBe('0.00125000');
          expect(received).not.toHaveProperty('sequence');
          const off = nextMessage(socket);
          socket.send(
            JSON.stringify({
              type: 'unsubscribe',
              channel: 'asset_order_book',
              assetId: 'btc',
            }),
          );
          expect(await off).toMatchObject({ type: 'unsubscribed' });
          socket.close();
          await once(socket, 'close');
        }
        expect(books.getStatus()).toMatchObject({
          accepted: 2,
          published: 2,
          publishFailed: 0,
        });
      } finally {
        for (const socket of sockets) socket.terminate();
        gateway.onModuleDestroy();
        await books.onModuleDestroy();
        await subscriber.onModuleDestroy();
        await publisher.onModuleDestroy();
        await redis.onModuleDestroy();
        raw.disconnect();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    20_000,
  );

  redisTest(
    'delivers USDⓈ-M books by instrument on their own channel',
    async () => {
      const config = readRedisConfig();
      if (!config.url) throw new Error('Set an isolated test REDIS_URL');
      const raw = new IORedis(config.url);
      const redis = new RedisService(config);
      const publisher = new OrderBookPubSubService(redis);
      const subscriber = new OrderBookPubSubService(redis);
      const instrument = {
        id: 'instrument-btc',
        underlyingAssetId: 'btc',
        isActive: true,
        productType: 'synthetic_perpetual',
        settlementCurrency: 'USD',
        markVerifiedAt: new Date(Date.now() - 60_000),
        markContractJson: {
          symbol: 'BTCUSDT',
          pair: 'BTCUSDT',
          baseAsset: 'BTC',
          contractType: 'PERPETUAL',
          status: 'TRADING',
          quoteAsset: 'USDT',
          marginAsset: 'USDT',
          underlyingType: 'COIN',
        },
        underlyingAsset: {
          symbol: 'BTCUSDT',
          isActive: true,
          assetType: 'crypto',
          market: 'BINANCE',
          currencyCode: 'USD',
          priceCurrency: 'USD',
          settlementCurrency: 'USD',
        },
      };
      const prisma = {
        futuresInstrument: {
          findMany: jest.fn().mockResolvedValue([instrument]),
          findUnique: jest.fn().mockResolvedValue(instrument),
        },
      };
      const ingestion = new FuturesMarketDataIngestion(
        prisma as never,
        { write: jest.fn().mockResolvedValue(true) } as never,
        publisher,
      );
      const gateway = new AssetTickerGateway(
        {
          user: {
            findUnique: jest.fn().mockResolvedValue({ status: 'active' }),
          },
        } as never,
        { verifyAsync: jest.fn().mockResolvedValue({ sub: 'smoke' }) } as never,
        { get: () => 'smoke-secret' } as never,
        {} as never,
        {} as never,
        new MarketPriceEventService(
          new KisRealtimePriceEventBus(),
          new BinanceRealtimePriceEventBus(),
        ),
        undefined,
        undefined,
        undefined,
        undefined,
        subscriber,
        new MarketOrderBookSubscriptionService(
          new BinanceOrderBookService(prisma as never, publisher),
          prisma as never,
        ),
      );
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        path: '/api/v1/ws',
      });
      server.on('connection', (socket, request) => {
        void gateway.handleConnection(socket, request);
        socket.on('close', () => gateway.handleDisconnect(socket));
      });
      let socket: WebSocket | undefined;
      try {
        subscriber.onModuleInit();
        gateway.onModuleInit();
        await once(server, 'listening');
        for (let attempt = 0; attempt < 100; attempt++) {
          const counts = (await raw.pubsub(
            'NUMSUB',
            FUTURES_ORDER_BOOK_CHANNEL,
          )) as [string, number];
          if (counts[1] > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (attempt === 99)
            throw new Error('Redis subscriber did not become ready');
        }
        const address = server.address();
        if (typeof address === 'string' || !address)
          throw new Error('Missing server address');
        await ingestion.refreshTargets();
        socket = new WebSocket(
          `ws://127.0.0.1:${address.port}/api/v1/ws?token=smoke`,
        );
        await once(socket, 'open');
        const ack = nextMessage(socket);
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            channel: 'futures_order_book',
            instrumentId: 'instrument-btc',
          }),
        );
        expect(await ack).toMatchObject({
          type: 'subscribed',
          channel: 'futures_order_book',
          instrumentId: 'instrument-btc',
        });
        const data = nextMessage(socket);
        const capturedAt = new Date();
        ingestion.acceptDepth(
          {
            stream: 'btcusdt@depth10@500ms',
            data: {
              e: 'depthUpdate',
              E: +capturedAt,
              T: +capturedAt - 1,
              s: 'BTCUSDT',
              U: 41,
              u: 42,
              pu: 40,
              a: Array.from({ length: 10 }, (_, i) => [
                `${62001 + i}.5`,
                '0.125',
              ]),
              b: Array.from({ length: 10 }, (_, i) => [
                `${62000 - i}.5`,
                '0.001',
              ]),
            },
          },
          capturedAt,
        );
        const received = await data;
        expect(received).toMatchObject({
          type: 'futures_order_book',
          instrumentId: 'instrument-btc',
          symbol: 'BTCUSDT',
          quantityUnit: 'BTC',
          priceUnit: 'USDT',
          capturedAt: capturedAt.toISOString(),
          effectiveAt: new Date(+capturedAt - 1).toISOString(),
        });
        expect(received.asks).toHaveLength(10);
        expect(received.bids).toHaveLength(10);
        expect(received).not.toHaveProperty('sequence');
        expect(received).not.toHaveProperty('assetId');
      } finally {
        socket?.terminate();
        gateway.onModuleDestroy();
        await ingestion.onModuleDestroy();
        await subscriber.onModuleDestroy();
        await publisher.onModuleDestroy();
        await redis.onModuleDestroy();
        raw.disconnect();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    20_000,
  );
});

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('App WebSocket message timeout')),
      5000,
    );
    socket.once('message', (data: Buffer) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });
  });
}
