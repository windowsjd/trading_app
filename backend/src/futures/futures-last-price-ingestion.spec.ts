import { BINANCE_FUTURES_SYMBOLS } from '../providers/binance/binance-product-catalog';
jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('ws', () => {
  const { EventEmitter } = jest.requireActual('node:events');
  return class Socket extends EventEmitter {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    send = jest.fn();
    ping = jest.fn();
    close = jest.fn(() => this.emit('close'));
    terminate = jest.fn(() => this.emit('close'));
    constructor(readonly url: string) {
      super();
      Socket.instances.push(this);
    }
  };
});
import WebSocket from 'ws';
import {
  FuturesLastPriceIngestion,
  FUTURES_LAST_REST_URL,
  FUTURES_LAST_WS_URL,
} from './futures-last-price-ingestion.service';
import { FUTURES_MARK_WS_URL } from './futures-mark-ingestion.service';
import { PrismaService } from '../prisma/prisma.service';

type MockSocket = WebSocket & {
  url: string;
  readyState: number;
  send: jest.Mock;
  ping: jest.Mock;
  terminate: jest.Mock;
};
const sockets = () =>
  (WebSocket as unknown as { instances: MockSocket[] }).instances;

describe('Futures Last Price ingestion', () => {
  const saved = { ...process.env };
  const oldFetch = global.fetch;
  let service: FuturesLastPriceIngestion;
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const groupBy = jest.fn();
  const findMany = jest.fn();
  const trade = (patch: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        stream: 'btcusdt@aggTrade',
        data: {
          e: 'aggTrade',
          E: Date.now() - 50,
          s: 'BTCUSDT',
          a: 10,
          p: '101.5',
          q: '1',
          T: Date.now() - 100,
          m: false,
          ...patch,
        },
      }),
    );
  const written = () =>
    createMany.mock.calls.flatMap(
      ([args]: [{ data: Array<Record<string, unknown>> }]) => args.data,
    );
  const restTask = () =>
    (service as unknown as { recoveryTask?: Promise<unknown> }).recoveryTask;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    process.env.FUTURES_LAST_PRICE_INGESTION_ENABLED = 'true';
    sockets().length = 0;
    createMany.mockClear();
    groupBy.mockReset().mockResolvedValue([{ instrumentId: 'i' }]);
    findMany
      .mockReset()
      .mockResolvedValue([{ id: 'i', underlyingAsset: { symbol: 'BTCUSDT' } }]);
    service = new FuturesLastPriceIngestion(
      {
        futuresInstrument: { findMany },
        futuresLastPriceSnapshot: { createMany, groupBy },
      } as unknown as PrismaService,
      { eval: jest.fn().mockResolvedValue([1, 0, 0]) } as never,
    );
    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              { symbol: 'BTCUSDT', price: '100.25', time: Date.now() - 20000 },
              { symbol: 'ETHUSDT', price: '1.5', time: Date.now() },
            ]),
          ),
      }),
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    process.env = { ...saved };
    global.fetch = oldFetch;
    jest.useRealTimers();
  });

  it('subscribes @aggTrade on its own socket for verified or held instruments', async () => {
    await service.cycle();
    const socket = sockets()[0];
    socket.emit('open');
    expect(socket.url).toBe(FUTURES_LAST_WS_URL);
    expect(sockets()).toHaveLength(1);
    expect(FUTURES_MARK_WS_URL).toBe(FUTURES_LAST_WS_URL);
    const subscribe = JSON.parse(socket.send.mock.calls[0][0]);
    expect(subscribe).toEqual({
      method: 'SUBSCRIBE',
      params: ['btcusdt@aggTrade'],
      id: 1,
    });
    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [
        {
          isActive: true,
          markVerifiedAt: { not: null },
          underlyingAsset: {
            isActive: true,
            symbol: { in: [...BINANCE_FUTURES_SYMBOLS] },
          },
        },
        { positions: { some: { status: 'open' } } },
      ],
    });
  });

  it('subscribes every selected exact contract, including all five Futures-only underlyings', async () => {
    findMany.mockResolvedValue(
      BINANCE_FUTURES_SYMBOLS.map((symbol) => ({
        id: symbol,
        underlyingAsset: { symbol },
      })),
    );
    await service.cycle();
    const socket = sockets()[0];
    socket.emit('open');
    expect(JSON.parse(socket.send.mock.calls[0][0]).params).toEqual(
      BINANCE_FUTURES_SYMBOLS.map((s) => `${s.toLowerCase()}@aggTrade`),
    );
  });

  it('keeps the newest aggregate trade per symbol and drops duplicates, reordering and foreign frames', async () => {
    await service.cycle();
    const socket = sockets()[0];
    socket.emit('message', trade({ a: 10, p: '101.5' }));
    socket.emit('message', trade({ a: 9, p: '1' }));
    socket.emit('message', trade({ a: 10, p: '999' }));
    socket.emit('message', trade({ a: 11, s: 'ETHUSDT', p: '5' }));
    socket.emit('message', trade({ a: 12, e: 'markPriceUpdate', p: '7' }));
    socket.emit('message', trade({ a: 13, st: 2, p: '8' }));
    socket.emit('message', trade({ a: 14, T: Date.now() + 1000, p: '9' }));
    socket.emit('message', trade({ a: 15, p: '0' }));
    socket.emit('message', Buffer.from('not json'));
    await service.cycle();
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({
      instrumentId: 'i',
      symbol: 'BTCUSDT',
      source: 'binance_usdm_agg_trade_ws',
      currencyCode: 'USD',
      providerProduct: 'binance_usdm_perpetual',
    });
    expect(String(written()[0].price)).toBe('101.5');
    expect('aggregateId' in written()[0]).toBe(false);
    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    socket.emit('message', trade({ a: 16, p: '102' }));
    socket.emit('message', trade({ a: 17, p: '103' }));
    await service.cycle();
    expect(written().map((row) => String(row.price))).toEqual(['101.5', '103']);
  });

  it('REST re-confirms only quiet symbols and never stores an older trade than one known', async () => {
    groupBy.mockResolvedValue([]);
    await service.cycle();
    await restTask();
    expect(global.fetch).toHaveBeenCalledWith(
      FUTURES_LAST_REST_URL,
      expect.anything(),
    );
    const rest = written().filter(
      (row) => row.source === 'binance_usdm_ticker_price_rest',
    );
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ symbol: 'BTCUSDT', instrumentId: 'i' });
    expect(+(rest[0].effectiveAt as Date)).toBe(Date.now() - 20000);
    // A WS trade newer than the REST trade time makes that REST reply stale news.
    sockets()[0].emit('message', trade({ a: 20, T: Date.now() - 10 }));
    jest.setSystemTime(Date.now() + 3000);
    createMany.mockClear();
    await service.cycle();
    await restTask();
    expect(
      written().filter(
        (row) => row.source === 'binance_usdm_ticker_price_rest',
      ),
    ).toHaveLength(0);
    expect(
      written().filter((row) => row.source === 'binance_usdm_agg_trade_ws'),
    ).toHaveLength(1);
  });

  it('skips REST when every target has a stored observation within 3 seconds', async () => {
    await service.cycle();
    await restTask();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a REST outage cannot fabricate evidence and never blocks the WS drain', async () => {
    groupBy.mockResolvedValue([]);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await service.cycle();
    await restTask();
    expect(createMany).not.toHaveBeenCalled();
    sockets()[0].emit('message', trade({ a: 30 }));
    await service.cycle();
    expect(written()).toHaveLength(1);
    expect(written()[0].source).toBe('binance_usdm_agg_trade_ws');
  });

  it('pings an open socket and replaces it after 15 seconds without frames or pongs', async () => {
    await service.cycle();
    const first = sockets()[0];
    first.readyState = 1;
    first.emit('open');
    jest.setSystemTime(Date.now() + 5000);
    await service.cycle();
    expect(first.ping).toHaveBeenCalledTimes(1);
    first.emit('pong');
    jest.setSystemTime(Date.now() + 14000);
    await service.cycle();
    expect(first.terminate).not.toHaveBeenCalled();
    jest.setSystemTime(Date.now() + 2000);
    await service.cycle();
    expect(first.terminate).toHaveBeenCalled();
    jest.setSystemTime(Date.now() + 5000);
    await service.cycle();
    expect(sockets()).toHaveLength(2);
  });

  it('follows the Mark ingestion flag by default and does no provider work when off', async () => {
    delete process.env.FUTURES_LAST_PRICE_INGESTION_ENABLED;
    process.env.FUTURES_MARK_INGESTION_ENABLED = 'false';
    await service.cycle();
    expect(sockets()).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    process.env.FUTURES_MARK_INGESTION_ENABLED = 'true';
    await service.cycle();
    expect(sockets()).toHaveLength(1);
  });
});
