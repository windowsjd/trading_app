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
    static instances: Socket[] = [];
    send = jest.fn();
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
  FuturesMarkIngestion,
  FUTURES_MARK_REST_URL,
  FUTURES_MARK_WS_URL,
} from './futures-mark-ingestion.service';
import { PrismaService } from '../prisma/prisma.service';

describe('Mark transport failure and independent REST recovery', () => {
  const saved = { ...process.env };
  const oldFetch = global.fetch;
  let service: FuturesMarkIngestion;
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const groupBy = jest.fn().mockResolvedValue([]);
  const targets = jest.fn();
  const sockets = () =>
    (
      WebSocket as unknown as {
        instances: Array<WebSocket & { send: jest.Mock; terminate: jest.Mock }>;
      }
    ).instances;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    process.env.FUTURES_MARK_INGESTION_ENABLED = 'true';
    sockets().length = 0;
    createMany.mockClear();
    groupBy.mockClear();
    targets
      .mockReset()
      .mockResolvedValue([{ id: 'i', underlyingAsset: { symbol: 'BTCUSDT' } }]);
    service = new FuturesMarkIngestion(
      {
        futuresInstrument: {
          findMany: targets,
        },
        futuresMarkSnapshot: { createMany, groupBy },
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
              { symbol: 'BTCUSDT', markPrice: '100', time: Date.now() },
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
  it('bootstraps public REST and subscribes the 1s typed mark stream, then reconnects after close', async () => {
    await service.cycle();
    const socket = sockets()[0];
    socket.emit('open');
    expect((socket as any).url).toBe(FUTURES_MARK_WS_URL);
    expect(JSON.parse(socket.send.mock.calls[0][0]).params).toEqual([
      'btcusdt@markPrice@1s',
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      FUTURES_MARK_REST_URL,
      expect.anything(),
    );
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({ source: 'binance_usdm_mark_rest' })],
      }),
    );
    socket.emit('close');
    jest.setSystemTime(Date.now() + 6000);
    await service.cycle();
    expect(sockets()).toHaveLength(2);
  });
  it('subscribes all 25 selected exact Mark streams, including Futures-only underlyings', async () => {
    targets.mockResolvedValue(
      BINANCE_FUTURES_SYMBOLS.map((symbol) => ({
        id: symbol,
        underlyingAsset: { symbol },
      })),
    );
    await service.cycle();
    const socket = sockets()[0];
    socket.emit('open');
    expect(JSON.parse(socket.send.mock.calls[0][0]).params).toEqual(
      BINANCE_FUTURES_SYMBOLS.map((s) => `${s.toLowerCase()}@markPrice@1s`),
    );
    expect(targets.mock.calls[0][0].where.OR[1]).toEqual({
      positions: { some: { status: 'open' } },
    });
  });

  it('coalesces duplicate/out-of-order frames and only writes valid provider evidence', async () => {
    await service.cycle();
    createMany.mockClear();
    const socket = sockets()[0];
    const send = (E: number, p = '101') =>
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            stream: 'btcusdt@markPrice@1s',
            data: { e: 'markPriceUpdate', s: 'BTCUSDT', p, E, st: 1 },
          }),
        ),
      );
    send(Date.now() - 100);
    send(Date.now() - 200, '1');
    send(Date.now() - 100, '999');
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          e: '24hrTicker',
          s: 'BTCUSDT',
          p: '999',
          E: Date.now(),
        }),
      ),
    );
    await service.cycle();
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      source: 'binance_usdm_mark_ws',
      price: expect.anything(),
    });
    expect(createMany.mock.calls[0][0].data[0].price.toString()).toBe('101');
  });
  it('REST failure cannot fabricate evidence and a later recovery can resume', async () => {
    jest.spyOn(service, 'refreshCoverage').mockResolvedValueOnce();
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await expect(service.cycle()).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
      message: 'binance request failed (PROVIDER_REQUEST_FAILED).',
    });
    expect(createMany).not.toHaveBeenCalled();
    jest.setSystemTime(Date.now() + 6000);
    await service.cycle();
    expect(createMany).toHaveBeenCalledTimes(1);
    sockets()[0].emit('error', new Error('disconnect'));
    expect(sockets()[0].terminate).toHaveBeenCalled();
  });
  it('does no provider work when ingestion is disabled', async () => {
    process.env.FUTURES_MARK_INGESTION_ENABLED = 'false';
    await service.cycle();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
  it('slow catalog verification does not delay Mark bootstrap or WS persistence', async () => {
    let release!: () => void;
    const coverage = jest.spyOn(service, 'refreshCoverage').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      await service.cycle();
      expect(createMany).toHaveBeenCalledTimes(1);
      sockets()[0].emit(
        'message',
        Buffer.from(
          JSON.stringify({
            e: 'markPriceUpdate',
            s: 'BTCUSDT',
            p: '101',
            E: Date.now(),
            st: 1,
          }),
        ),
      );
      await service.cycle();
      expect(createMany.mock.calls.at(-1)[0].data[0].source).toBe(
        'binance_usdm_mark_ws',
      );
      expect(coverage).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });
});
