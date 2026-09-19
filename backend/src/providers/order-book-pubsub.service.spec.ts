jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
jest.mock('ioredis', () => jest.fn());
jest.mock('../redis/redis.config', () => ({
  readRedisConfig: () => ({
    url: 'redis://test',
    connectTimeoutMs: 100,
    commandTimeoutMs: 100,
  }),
}));
import { EventEmitter } from 'node:events';
import IORedis from 'ioredis';
import {
  OrderBookPubSubService,
  ORDER_BOOK_CHANNEL,
} from './order-book-pubsub.service';
import { parseOrderBookEvent, type OrderBookEvent } from './order-book.types';

const event: OrderBookEvent = {
  type: 'asset_order_book',
  sequence: '123',
  book: {
    assetId: 'btc',
    priceUnit: 'USDT',
    quantityUnit: 'BTC',
    marketLabel: 'BTC / USDT',
    asks: [{ price: '1.00', quantity: '0.00000100' }],
    bids: [],
    capturedAt: '2026-09-19T00:00:00.000Z',
    effectiveAt: null,
  },
};

describe('order book Redis fanout', () => {
  it('validates and strips unknown fields at the cross-instance boundary', () => {
    expect(
      parseOrderBookEvent(
        JSON.stringify({
          ...event,
          raw: 'provider',
          book: { ...event.book, raw: 'provider' },
        }),
      ),
    ).toEqual(event);
    for (const value of [
      null,
      [],
      {},
      { ...event, sequence: 1 },
      { ...event, book: { ...event.book, capturedAt: 'invalid' } },
      {
        ...event,
        book: { ...event.book, asks: [{ price: '1', quantity: '-1' }] },
      },
      { ...event, book: { ...event.book, assetId: '' } },
    ]) {
      expect(parseOrderBookEvent(JSON.stringify(value))).toBeNull();
    }
    expect(parseOrderBookEvent('invalid')).toBeNull();
  });

  it('delivers publications to separate instances, re-subscribes after Redis recovery and cleans up', async () => {
    const clients: Array<ReturnType<typeof client>> = [];
    function client() {
      return Object.assign(new EventEmitter(), {
        subscribe: jest.fn().mockResolvedValue(1),
        connect: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(0),
        quit: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
      });
    }
    (IORedis as unknown as jest.Mock).mockImplementation(() => {
      const next = client();
      clients.push(next);
      return next;
    });
    const redis = {
      publish: jest
        .fn()
        .mockImplementation((channel: string, message: string) => {
          for (const instance of clients)
            instance.emit('message', channel, message);
          return Promise.resolve(clients.length);
        }),
    };
    const owner = new OrderBookPubSubService(redis as never);
    const app = new OrderBookPubSubService(redis as never);
    const receive = jest.fn();
    const off = app.subscribe(receive);
    owner.onModuleInit();
    app.onModuleInit();
    for (const instance of clients) instance.emit('ready');
    await owner.publish(event);
    expect(receive).toHaveBeenCalledWith(event);
    clients[1].emit('message', ORDER_BOOK_CHANNEL, 'invalid');
    clients[1].emit('message', 'other', JSON.stringify(event));
    expect(receive).toHaveBeenCalledTimes(1);
    clients[1].emit('ready');
    expect(clients[1].subscribe).toHaveBeenCalledTimes(2);
    off();
    await owner.publish(event);
    expect(receive).toHaveBeenCalledTimes(1);
    await owner.onModuleDestroy();
    await app.onModuleDestroy();
    expect(
      clients.every((instance) => instance.quit.mock.calls.length === 1),
    ).toBe(true);
    redis.publish.mockRejectedValueOnce(new Error('offline'));
    expect(await owner.publish(event)).toBe(false);
  });
});
