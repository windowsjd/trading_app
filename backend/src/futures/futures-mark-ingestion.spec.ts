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
    close = jest.fn(() => this.emit('close'));
    terminate = jest.fn(() => this.emit('close'));
    constructor(readonly url: string) {
      super();
      Socket.instances.push(this);
    }
  };
});
import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import {
  FuturesMarkIngestion,
  FUTURES_MARK_REST_URL,
  FUTURES_MARK_WS_URL,
} from './futures-mark-ingestion.service';
import { PrismaService } from '../prisma/prisma.service';

type Row = {
  symbol: string;
  source: string;
  effectiveAt: Date;
  price: unknown;
};
const sockets = () =>
  (
    WebSocket as unknown as {
      instances: Array<
        WebSocket & {
          url: string;
          readyState: number;
          send: jest.Mock;
          terminate: jest.Mock;
        }
      >;
    }
  ).instances;
const frame = (s: string, E: number, p = '101') =>
  Buffer.from(
    JSON.stringify({
      stream: `${s.toLowerCase()}@markPrice@1s`,
      data: { e: 'markPriceUpdate', s, p, E, st: 1 },
    }),
  );
const events = (spy: jest.SpyInstance) =>
  spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('Futures Mark ingestion', () => {
  const saved = { ...process.env };
  const oldFetch = global.fetch;
  let service: FuturesMarkIngestion;
  let restSymbols: string[];
  const createMany = jest.fn();
  const targets = jest.fn();
  const prisma = () =>
    ({
      futuresInstrument: {
        findMany: targets,
        update: jest.fn().mockResolvedValue({}),
      },
      // No groupBy/findFirst/count: the collector must never read Mark rows.
      futuresMarkSnapshot: { createMany },
    }) as unknown as PrismaService;
  const make = () =>
    new FuturesMarkIngestion(prisma(), {
      eval: jest.fn().mockResolvedValue([1, 0, 0]),
    } as never);
  const useTargets = (symbols: string[]) =>
    targets.mockResolvedValue(
      symbols.map((symbol) => ({
        id: `id-${symbol}`,
        underlyingAsset: { symbol },
      })),
    );
  const written = (): Row[] =>
    createMany.mock.calls.flatMap(([args]: [{ data: Row[] }]) => args.data);
  const restRows = () =>
    written().filter((row) => row.source === 'binance_usdm_mark_rest');
  const wsRows = () =>
    written().filter((row) => row.source === 'binance_usdm_mark_ws');
  const restTask = (s = service) =>
    (s as unknown as { recoveryTask?: Promise<unknown> }).recoveryTask;
  const restCalls = () =>
    (global.fetch as jest.Mock).mock.calls.filter(
      ([url]) => url === FUTURES_MARK_REST_URL,
    ).length;
  const emitAll = (symbols: string[], E = Date.now() - 50) => {
    for (const s of symbols) sockets().at(-1)!.emit('message', frame(s, E));
  };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    process.env.FUTURES_MARK_INGESTION_ENABLED = 'true';
    sockets().length = 0;
    createMany
      .mockReset()
      .mockImplementation(({ data }: { data: Row[] }) =>
        Promise.resolve({ count: data.length }),
      );
    useTargets(['BTCUSDT']);
    restSymbols = ['BTCUSDT'];
    service = make();
    global.fetch = jest.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify(
              url === FUTURES_MARK_REST_URL
                ? restSymbols.map((symbol) => ({
                    symbol,
                    markPrice: '100',
                    time: Date.now(),
                  }))
                : { symbols: [] },
            ),
          ),
      }),
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    process.env = { ...saved };
    global.fetch = oldFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('bootstraps public REST and subscribes the 1s typed mark stream, then reconnects after close', async () => {
    await service.cycle();
    await restTask();
    const socket = sockets()[0];
    socket.emit('open');
    expect(socket.url).toBe(FUTURES_MARK_WS_URL);
    expect(JSON.parse(socket.send.mock.calls[0][0]).params).toEqual([
      'btcusdt@markPrice@1s',
    ]);
    expect(restCalls()).toBe(1);
    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(restRows().map((row) => row.symbol)).toEqual(['BTCUSDT']);
    socket.emit('close');
    jest.setSystemTime(Date.now() + 6000);
    await service.cycle();
    expect(sockets()).toHaveLength(2);
  });

  it('subscribes all 25 selected exact Mark streams, including Futures-only underlyings', async () => {
    useTargets([...BINANCE_FUTURES_SYMBOLS]);
    await service.cycle();
    const socket = sockets()[0];
    socket.emit('open');
    expect(JSON.parse(socket.send.mock.calls[0][0]).params).toEqual(
      BINANCE_FUTURES_SYMBOLS.map((s) => `${s.toLowerCase()}@markPrice@1s`),
    );
    // Instruments held only by an open position stay collected.
    expect(targets.mock.calls[0][0].where.OR[1]).toEqual({
      positions: { some: { status: 'open' } },
    });
  });

  it.each([25, 100])(
    'stores %i contracts with ONE multi-row INSERT per drain and never queries Mark freshness',
    async (n) => {
      const symbols = Array.from(
        { length: n },
        (_, i) => `C${String(i).padStart(3, '0')}USDT`,
      );
      useTargets(symbols);
      restSymbols = symbols;
      await service.cycle();
      await restTask();
      createMany.mockClear();
      for (let second = 1; second <= 3; second++) {
        jest.setSystemTime(Date.now() + 1000);
        emitAll(symbols);
        await service.cycle();
      }
      expect(createMany).toHaveBeenCalledTimes(3);
      expect(createMany.mock.calls.every(([a]) => a.data.length === n)).toBe(
        true,
      );
      // Every target has a stored WS Mark within 3 s: no REST call at all.
      expect(restCalls()).toBe(1);
      expect(service.getStatus().staleTargets).toBe(0);
    },
  );

  it('coalesces duplicate, out-of-order and future frames, including replays after a drain', async () => {
    await service.cycle();
    await restTask();
    createMany.mockClear();
    const socket = sockets()[0];
    socket.emit('message', frame('BTCUSDT', Date.now() - 100, '101'));
    socket.emit('message', frame('BTCUSDT', Date.now() - 200, '1'));
    socket.emit('message', frame('BTCUSDT', Date.now() - 100, '999'));
    socket.emit('message', frame('BTCUSDT', Date.now() + 1000, '7'));
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
    expect(wsRows().map((row) => String(row.price))).toEqual(['101']);
    // A replay of an already drained provider time cannot re-enter.
    socket.emit('message', frame('BTCUSDT', Date.now() - 150, '55'));
    await service.cycle();
    expect(wsRows()).toHaveLength(1);
  });

  it('REST re-confirms only targets without a stored WS Mark for 3 s; one call in flight, at most every 3 s', async () => {
    useTargets(['BTCUSDT', 'ETHUSDT']);
    restSymbols = ['BTCUSDT', 'ETHUSDT'];
    await service.cycle();
    await restTask();
    emitAll(['BTCUSDT', 'ETHUSDT']);
    await service.cycle();
    createMany.mockClear();
    // ETH goes silent; BTC keeps streaming.
    const gate = deferred<void>();
    const ok = (global.fetch as jest.Mock).getMockImplementation()!;
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      await gate.promise;
      return ok(url);
    });
    for (let second = 1; second <= 3; second++) {
      jest.setSystemTime(Date.now() + 1000);
      emitAll(['BTCUSDT']);
      await service.cycle();
    }
    jest.setSystemTime(Date.now() + 500);
    emitAll(['BTCUSDT']);
    await service.cycle();
    expect(restCalls()).toBe(2);
    // The REST call is still in flight: further cycles drain WS, no second call.
    for (let second = 1; second <= 4; second++) {
      jest.setSystemTime(Date.now() + 1000);
      emitAll(['BTCUSDT']);
      await service.cycle();
    }
    expect(restCalls()).toBe(2);
    expect(wsRows().length).toBeGreaterThanOrEqual(5);
    gate.resolve();
    await restTask();
    expect(restRows().map((row) => row.symbol)).toEqual(['ETHUSDT']);
    // ETH is still silent: the next call is due once 3 s passed since the
    // previous one STARTED, and never sooner.
    await service.cycle();
    await restTask();
    expect(restCalls()).toBe(3);
    await service.cycle();
    jest.setSystemTime(Date.now() + 2900);
    await service.cycle();
    await restTask();
    expect(restCalls()).toBe(3);
    jest.setSystemTime(Date.now() + 100);
    await service.cycle();
    await restTask();
    expect(restCalls()).toBe(4);
  });

  it('a REST outage cannot fabricate evidence, never blocks the WS drain, and a later recovery resumes', async () => {
    jest.spyOn(service, 'refreshCoverage').mockResolvedValue();
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await service.cycle();
    await restTask();
    expect(createMany).not.toHaveBeenCalled();
    expect(service.getStatus().consecutiveRecoveryFailures).toBe(1);
    emitAll(['BTCUSDT']);
    await service.cycle();
    expect(wsRows()).toHaveLength(1);
    expect(restRows()).toHaveLength(0);
    jest.setSystemTime(Date.now() + 6000);
    await service.cycle();
    await restTask();
    expect(restRows()).toHaveLength(1);
    expect(service.getStatus().consecutiveRecoveryFailures).toBe(0);
    sockets()[0].emit('error', new Error('disconnect'));
    expect(sockets()[0].terminate).toHaveBeenCalled();
  });

  it('a received but unstored frame is never fresh: the failed write is reported and REST recovers it', async () => {
    await service.cycle();
    await restTask();
    createMany.mockClear();
    jest.setSystemTime(Date.now() + 3000);
    emitAll(['BTCUSDT']);
    createMany.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.cycle()).rejects.toThrow('connection reset');
    const status = service.getStatus();
    expect(status.lastFrameAgeMs === null).toBe(false);
    expect(status.consecutivePersistFailures).toBe(1);
    expect(status.lastPersistFailure?.kind).toBe('unknown');
    // The WS row was not stored, so the target is quiet and REST runs.
    await restTask();
    expect(restRows()).toHaveLength(1);
    expect(service.getStatus().consecutivePersistFailures).toBe(0);
  });

  it('classifies disk-full writes and alerts with fixed fields only', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await service.cycle();
    await restTask();
    emitAll(['BTCUSDT']);
    createMany.mockRejectedValueOnce(
      Object.assign(new Error('Futures write failed'), {
        name: 'DriverAdapterError',
        cause: {
          kind: 'postgres',
          originalCode: '53100',
          originalMessage:
            'could not extend file "base/16389/29548": No space left on device',
        },
      }),
    );
    await expect(service.cycle()).rejects.toBeTruthy();
    expect(service.getStatus().lastPersistFailure?.kind).toBe('disk_full');
    expect(
      events(error).some(
        (line) => line.event === 'db_disk_full' && line.kind === 'disk_full',
      ),
    ).toBe(true);
    const logged = error.mock.calls.map(([line]) => String(line)).join('\n');
    // Driver text (file paths, OS messages) never reaches the logs.
    expect(logged.includes('base/16389')).toBe(false);
    expect(logged.includes('No space left')).toBe(false);
  });

  it('one rejected contract cannot stop the others from being stored', async () => {
    useTargets(['BADUSDT', 'BTCUSDT', 'ETHUSDT']);
    restSymbols = [];
    await service.cycle();
    await restTask();
    createMany.mockImplementation(({ data }: { data: Row[] }) =>
      data.some((row) => row.symbol === 'BADUSDT')
        ? Promise.reject(
            Object.assign(new Error('identity'), {
              cause: { kind: 'postgres', originalCode: '23514' },
            }),
          )
        : Promise.resolve({ count: data.length }),
    );
    emitAll(['BADUSDT', 'BTCUSDT', 'ETHUSDT']);
    await service.cycle();
    const stored = new Set(
      createMany.mock.calls
        .filter(([a]) => a.data.length === 1)
        .map(([a]) => a.data[0].symbol),
    );
    expect([...stored].sort()).toEqual(['BADUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(service.getStatus().lastPersistFailure?.kind).toBe('data_rejected');
    jest.setSystemTime(Date.now() + 6000);
    emitAll(['BADUSDT', 'BTCUSDT', 'ETHUSDT']);
    await service.cycle();
    // BTC/ETH keep fresh stored Marks; only the rejected contract is stale.
    jest.setSystemTime(Date.now() + 100);
    expect(service.getStatus().staleTargets).toBe(1);
  });

  it('a slow database write holds one drain: cycles never overlap, frames coalesce to the newest, staleness is still reported', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    await service.cycle();
    await restTask();
    createMany.mockClear();
    const write = deferred<{ count: number }>();
    createMany.mockReturnValueOnce(write.promise);
    emitAll(['BTCUSDT'], Date.now() - 50);
    const held = service.cycle();
    for (let second = 1; second <= 6; second++) {
      jest.setSystemTime(Date.now() + 1000);
      emitAll(['BTCUSDT']);
      await service.cycle();
    }
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(service.getStatus().staleTargets).toBe(1);
    expect(
      events(warn).some((line) => line.event === 'futures_mark_stale'),
    ).toBe(true);
    write.resolve({ count: 1 });
    await held;
    await service.cycle();
    expect(createMany).toHaveBeenCalledTimes(2);
    // Only the newest pending frame per contract is written after the stall.
    expect(createMany.mock.calls[1][0].data).toHaveLength(1);
    expect(+createMany.mock.calls[1][0].data[0].effectiveAt).toBe(
      Date.now() - 50,
    );
    expect(service.getStatus().staleTargets).toBe(0);
  });

  it('reports each target separately: one silent contract is stale after 5 s while others stay fresh', async () => {
    useTargets(['BTCUSDT', 'ETHUSDT']);
    restSymbols = ['BTCUSDT', 'ETHUSDT'];
    await service.cycle();
    await restTask();
    emitAll(['BTCUSDT', 'ETHUSDT']);
    await service.cycle();
    // REST cannot help ETH either.
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    for (let second = 1; second <= 6; second++) {
      jest.setSystemTime(Date.now() + 1000);
      emitAll(['BTCUSDT']);
      await service.cycle();
      await restTask();
    }
    const status = service.getStatus();
    expect(status.targets).toBe(2);
    expect(status.staleTargets).toBe(1);
    expect(status.missingTargets).toBe(0);
  });

  it('a full WS outage re-confirms every target by REST, replaces the socket after 15 s and resubscribes', async () => {
    useTargets(['BTCUSDT', 'ETHUSDT']);
    restSymbols = ['BTCUSDT', 'ETHUSDT'];
    await service.cycle();
    await restTask();
    sockets()[0].emit('open');
    emitAll(['BTCUSDT', 'ETHUSDT']);
    await service.cycle();
    createMany.mockClear();
    for (let second = 1; second <= 16; second++) {
      jest.setSystemTime(Date.now() + 1000);
      await service.cycle();
      await restTask();
    }
    expect(sockets()[0].terminate).toHaveBeenCalled();
    expect(new Set(restRows().map((row) => row.symbol)).size).toBe(2);
    // REST spacing: at most one call per 3 s.
    expect(restCalls()).toBeLessThanOrEqual(1 + Math.ceil(16 / 3));
    jest.setSystemTime(Date.now() + 5000);
    await service.cycle();
    const next = sockets().at(-1)!;
    next.emit('open');
    expect(next).not.toBe(sockets()[0]);
    expect(JSON.parse(next.send.mock.calls[0][0]).params).toEqual([
      'btcusdt@markPrice@1s',
      'ethusdt@markPrice@1s',
    ]);
  });

  it('a restarted process has no stored freshness and re-confirms every target at once', async () => {
    useTargets(['BTCUSDT', 'ETHUSDT']);
    restSymbols = ['BTCUSDT', 'ETHUSDT'];
    await service.cycle();
    await restTask();
    emitAll(['BTCUSDT', 'ETHUSDT']);
    await service.cycle();
    await service.onModuleDestroy();
    createMany.mockClear();
    service = make();
    await service.cycle();
    await restTask();
    expect(
      restRows()
        .map((row) => row.symbol)
        .sort(),
    ).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('does no provider work when ingestion is disabled', async () => {
    process.env.FUTURES_MARK_INGESTION_ENABLED = 'false';
    await service.cycle();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(service.getStatus().enabled).toBe(false);
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
      await restTask();
      expect(createMany).toHaveBeenCalledTimes(1);
      emitAll(['BTCUSDT']);
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
