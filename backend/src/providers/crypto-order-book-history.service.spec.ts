jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
  PrismaClient: class {},
  AssetType: { crypto: 'crypto' },
  CurrencyCode: { USD: 'USD' },
}));
import {
  CryptoOrderBookHistoryService,
  type OrderBookHistoryBook,
} from './crypto-order-book-history.service';
import { BinanceOrderBookService } from './binance/binance-order-book.service';

const T0 = Date.parse('2026-10-16T07:00:00.000Z');
const ENABLED = 'CRYPTO_ORDER_BOOK_HISTORY_ENABLED';

type Row = Record<string, unknown> & {
  bucketStartAt: Date;
  capturedAt: Date;
  sequence: bigint;
  bids: string[][];
  asks: string[][];
};

function book(sequence: number | string, bid = '100.10', ask = '100.20') {
  return {
    sequence: String(sequence),
    bids: [
      { price: bid, quantity: '1.50000000' },
      { price: '100.00', quantity: '2' },
    ],
    asks: [
      { price: ask, quantity: '0.25' },
      { price: '100.30', quantity: '3' },
    ],
  } satisfies OrderBookHistoryBook;
}

/** Prisma double: $transaction runs the callback against `tx`. */
function setup(enabled = true) {
  if (enabled) process.env[ENABLED] = 'true';
  else delete process.env[ENABLED];
  const spot: Row[] = [];
  const futures: Row[] = [];
  const stored = new Set<string>();
  const createMany = (target: Row[], key: string) =>
    jest.fn((args: { data: Row[]; skipDuplicates: boolean }) => {
      expect(args.skipDuplicates).toBe(true);
      let count = 0;
      for (const row of args.data) {
        const id = `${key}:${+row.bucketStartAt}:${String(row[key])}`;
        if (stored.has(id)) continue;
        stored.add(id);
        target.push(row);
        count++;
      }
      return Promise.resolve({ count });
    });
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    cryptoSpotOrderBookSnapshot: { createMany: createMany(spot, 'assetId') },
    futuresOrderBookSnapshot: {
      createMany: createMany(futures, 'instrumentId'),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      (fn: (client: typeof tx) => Promise<unknown>, options: unknown) => {
        expect(options).toEqual({ timeout: 10_000 });
        return fn(tx);
      },
    ),
  };
  const service = new CryptoOrderBookHistoryService(prisma as never);
  return { service, prisma, tx, spot, futures, stored };
}

const at = (ms: number) => new Date(T0 + ms);

async function drain(service: CryptoOrderBookHistoryService, now: number) {
  service.tick(T0 + now);
  await service.settled();
}

afterEach(() => {
  delete process.env[ENABLED];
  delete process.env.CRYPTO_ORDER_BOOK_RETENTION_ENABLED;
  jest.restoreAllMocks();
});

describe('crypto order book history (60 s sampling)', () => {
  it('is off by default: no timer, no rows, no database call', async () => {
    const { service, prisma } = setup(false);
    service.onModuleInit();
    for (let s = 0; s < 130; s++)
      service.offerSpot('btc', book(s), at(s * 1000));
    await drain(service, 130_000);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      enabled: false,
      pendingRows: 0,
    });
  });

  it('stores at most one book per product and minute: the newest one, with its own receipt time', async () => {
    const { service, spot } = setup();
    // One book per second for 2.5 minutes, plus duplicate bursts; the 1 s
    // timer runs between them as in production.
    for (let s = 0; s < 150; s++) {
      service.offerSpot('btc', book(1000 + s), at(s * 1000));
      service.offerSpot('btc', book(1000 + s), at(s * 1000 + 10));
      await drain(service, s * 1000 + 500);
    }
    expect(spot).toHaveLength(2);
    expect(spot.map((row) => row.bucketStartAt.toISOString())).toEqual([
      '2026-10-16T07:00:00.000Z',
      '2026-10-16T07:01:00.000Z',
    ]);
    expect(spot.map((row) => row.capturedAt.toISOString())).toEqual([
      '2026-10-16T07:00:59.010Z',
      '2026-10-16T07:01:59.010Z',
    ]);
    expect(spot.map((row) => row.sequence)).toEqual([1059n, 1119n]);
    // The open third minute is not written before it ends.
    expect(service.getStatus()).toMatchObject({
      pendingRows: 0,
      trackedProducts: { spot: 1, futures: 0 },
      counts: { closedMinutes: 2, inserted: 2, duplicates: 0 },
    });
  });

  it('keeps exact provider decimal strings for all levels, best first', async () => {
    const { service, spot } = setup();
    const levels = {
      sequence: '76543210987',
      bids: Array.from({ length: 10 }, (_, i) => ({
        price: `0.0000${381 - i}0`,
        quantity: '123456789.00000000',
      })),
      asks: Array.from({ length: 10 }, (_, i) => ({
        price: `0.0000${382 + i}0`,
        quantity: '0.00000001',
      })),
    };
    service.offerSpot('pepe', levels, at(59_000));
    await drain(service, 60_000);
    expect(spot).toHaveLength(1);
    expect(spot[0].bids).toEqual(levels.bids.map((l) => [l.price, l.quantity]));
    expect(spot[0].asks).toEqual(levels.asks.map((l) => [l.price, l.quantity]));
    expect(spot[0].sequence).toBe(76543210987n);
  });

  it('keeps the same symbol on Spot and USDⓈ-M as two separate histories keyed by asset and instrument', async () => {
    const { service, spot, futures, tx } = setup();
    service.offerSpot('asset-btc', book(1), at(58_000));
    service.offerFutures(
      'instrument-btc',
      { ...book(9), effectiveAt: at(57_900).toISOString() },
      at(58_100),
    );
    await drain(service, 60_000);
    expect(spot).toEqual([
      expect.objectContaining({ assetId: 'asset-btc', sequence: 1n }),
    ]);
    expect(spot[0]).not.toHaveProperty('instrumentId');
    expect(futures).toEqual([
      expect.objectContaining({
        instrumentId: 'instrument-btc',
        sequence: 9n,
        effectiveAt: at(57_900),
        capturedAt: at(58_100),
      }),
    ]);
    expect(futures[0]).not.toHaveProperty('assetId');
    expect(tx.cryptoSpotOrderBookSnapshot.createMany).toHaveBeenCalledTimes(1);
    expect(tx.futuresOrderBookSnapshot.createMany).toHaveBeenCalledTimes(1);
  });

  it('writes 100 Spot and 100 USDⓈ-M minutes with one bounded INSERT per table', async () => {
    const { service, spot, futures, tx } = setup();
    for (let s = 0; s < 60; s++)
      for (let i = 0; i < 100; i++) {
        service.offerSpot(`asset-${i}`, book(s), at(s * 1000 + i));
        service.offerFutures(
          `instrument-${i}`,
          { ...book(s), effectiveAt: at(s * 1000 + i - 20).toISOString() },
          at(s * 1000 + 500 + i),
        );
      }
    await drain(service, 60_000);
    expect(spot).toHaveLength(100);
    expect(futures).toHaveLength(100);
    expect(tx.cryptoSpotOrderBookSnapshot.createMany).toHaveBeenCalledTimes(1);
    expect(tx.futuresOrderBookSnapshot.createMany).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(new Set(spot.map((row) => row.assetId)).size).toBe(100);
  });

  it('stores nothing for a minute whose newest book was no longer current at its end', async () => {
    const { service, spot } = setup();
    // Minute 0: the stream stopped 5.001 s before the end.
    service.offerSpot('btc', book(1), at(54_999));
    // Minute 1: exactly 5 s before the end is still current.
    service.offerSpot('btc', book(2), at(115_000));
    // Minute 2: nothing received at all.
    await drain(service, 180_000);
    expect(spot.map((row) => row.sequence)).toEqual([2n]);
    expect(service.getStatus().counts).toMatchObject({
      closedMinutes: 2,
      staleMinutes: 1,
    });
  });

  it('never re-stores an old book under a later minute after the stream goes silent', async () => {
    const { service, spot } = setup();
    service.offerSpot('btc', book(1), at(59_500));
    for (const now of [60_000, 120_000, 180_000, 240_000])
      await drain(service, now);
    expect(spot).toHaveLength(1);
    expect(spot[0].capturedAt).toEqual(at(59_500));
  });

  it('refuses delayed or clock-skewed USDⓈ-M books and keeps the minute’s last valid one', async () => {
    const { service, futures } = setup();
    const offer = (seq: number, provider: number, received: number) =>
      service.offerFutures(
        'inst',
        { ...book(seq), effectiveAt: at(provider).toISOString() },
        at(received),
      );
    offer(1, 57_000, 57_100); // valid
    offer(2, 52_000, 58_000); // 6 s old at receipt: delayed backlog frame
    offer(3, 64_500, 58_500); // 6 s in the future: broken clock
    service.offerFutures('inst', { ...book(4), effectiveAt: null }, at(59_000));
    await drain(service, 60_000);
    expect(futures.map((row) => row.sequence)).toEqual([1n]);
    expect(service.getStatus().counts.invalid).toBe(3);
  });

  it('refuses abnormal books: empty side, crossed, zero quantity, oversized sequence', async () => {
    const { service, spot } = setup();
    const base = book(5);
    for (const bad of [
      { ...base, bids: [] },
      { ...base, asks: [] },
      book(6, '100.20', '100.20'),
      book(7, '100.30', '100.20'),
      {
        ...base,
        asks: [{ price: '100.20', quantity: '0.00000000' }],
      },
      { ...base, sequence: '9223372036854775808' },
      { ...base, sequence: '-1' },
    ])
      service.offerSpot('btc', bad, at(59_000));
    await drain(service, 60_000);
    expect(spot).toHaveLength(0);
    expect(service.getStatus().counts.invalid).toBe(7);
  });

  it('ignores books for a minute it already closed (wall clock stepped back)', async () => {
    const { service, spot } = setup();
    service.offerSpot('btc', book(1), at(59_000));
    service.offerSpot('btc', book(2), at(60_500)); // closes minute 0
    service.offerSpot('btc', book(3), at(59_800)); // clock stepped back
    await drain(service, 61_000);
    expect(spot.map((row) => row.sequence)).toEqual([1n]);
    expect(service.getStatus().counts.late).toBe(1);
  });

  it('a minute another instance or a restarted process already stored is a counted no-op', async () => {
    const first = setup();
    first.service.offerSpot('btc', book(1), at(59_000));
    await drain(first.service, 60_000);
    // A second writer (deploy overlap, restart) with its own book for the minute.
    const second = new CryptoOrderBookHistoryService({
      $transaction: first.prisma.$transaction,
    } as never);
    second.offerSpot('btc', book(2), at(59_400));
    await drain(second, 60_000);
    expect(first.spot.map((row) => row.sequence)).toEqual([1n]);
    expect(second.getStatus().counts).toMatchObject({
      inserted: 0,
      duplicates: 1,
    });
  });

  it('isolates a database outage: bounded queue, backoff, newer minutes supersede, recovery writes', async () => {
    const { service, prisma, spot } = setup();
    const outage = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const real = prisma.$transaction.getMockImplementation()!;
    prisma.$transaction.mockImplementation(() => Promise.reject(outage));
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    service.offerSpot('btc', book(1), at(59_000));
    service.offerSpot('eth', book(1), at(59_000));
    await drain(service, 60_000);
    expect(service.getStatus()).toMatchObject({
      pendingRows: 2,
      consecutiveWriteFailures: 1,
      lastWriteFailure: { kind: 'connection' },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    // Backoff: no retry before 2 s have passed.
    const calls = prisma.$transaction.mock.calls.length;
    await drain(service, 61_000);
    expect(prisma.$transaction.mock.calls.length).toBe(calls);
    // The next minute of the same products replaces the unwritten one.
    service.offerSpot('btc', book(2), at(119_000));
    service.offerSpot('eth', book(2), at(119_000));
    service.offerSpot('btc', book(3), at(120_500));
    service.offerSpot('eth', book(3), at(120_500));
    expect(service.getStatus()).toMatchObject({
      pendingRows: 2,
      counts: { superseded: 2 },
    });
    prisma.$transaction.mockImplementation(real);
    await drain(service, 125_000);
    expect(spot.map((row) => row.sequence)).toEqual([2n, 2n]);
    expect(service.getStatus()).toMatchObject({
      pendingRows: 0,
      consecutiveWriteFailures: 0,
    });
  });

  it('a row the database refuses never blocks the rest of the minute', async () => {
    const { service, tx, spot } = setup();
    const create = tx.cryptoSpotOrderBookSnapshot.createMany;
    const original = create.getMockImplementation()!;
    create.mockImplementation((args) => {
      if (args.data.some((row) => row.assetId === 'bad'))
        return Promise.reject(
          Object.assign(new Error('check violation'), {
            cause: { originalCode: '23514' },
          }),
        );
      return original(args);
    });
    service.offerSpot('good', book(1), at(59_000));
    service.offerSpot('bad', book(1), at(59_000));
    await drain(service, 60_000);
    expect(spot.map((row) => row.assetId)).toEqual(['good']);
    expect(service.getStatus()).toMatchObject({
      pendingRows: 0,
      consecutiveWriteFailures: 0,
      counts: { inserted: 1, rejected: 1 },
    });
  });

  it('flushes closed minutes once on shutdown and leaves the open minute unwritten', async () => {
    const { service, spot } = setup();
    service.onModuleInit();
    service.offerSpot('btc', book(1), at(59_000));
    service.offerSpot('btc', book(2), at(60_500));
    await service.onModuleDestroy();
    expect(spot.map((row) => row.sequence)).toEqual([1n]);
    service.offerSpot('btc', book(3), at(61_000));
    expect(service.getStatus().pendingRows).toBe(0);
  });

  it('the realtime publish never waits for history: a stuck write leaves handleFrame and publish unaffected', async () => {
    const history = setup();
    history.prisma.$transaction.mockImplementation(
      () => new Promise(() => undefined),
    );
    const pubsub = { publish: jest.fn().mockResolvedValue(true) };
    const orderBooks = new BinanceOrderBookService(
      {} as never,
      pubsub as never,
      history.service,
    );
    const targets = new Map([
      ['BTCUSDT', { assetId: 'btc', symbol: 'BTCUSDT', baseAsset: 'BTC' }],
    ]);
    const frame = (id: number) =>
      JSON.stringify({
        stream: 'btcusdt@depth10',
        data: {
          lastUpdateId: id,
          asks: [['68420.10000000', '0.00125000']],
          bids: [['68420.09000000', '1.00000000']],
        },
      });
    expect(orderBooks.handleFrame(frame(1), at(59_000), targets)).toBe(true);
    history.service.tick(T0 + 60_000); // write starts and never finishes
    for (let id = 2; id <= 120; id++)
      expect(
        orderBooks.handleFrame(frame(id), at(60_000 + id * 500), targets),
      ).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pubsub.publish.mock.calls.length).toBeGreaterThan(1);
    const last = pubsub.publish.mock.calls.at(-1) as unknown as [
      { sequence: string },
    ];
    expect(last[0].sequence).toBe('120');
    expect(history.service.getStatus()).toMatchObject({
      writeInFlight: true,
      pendingRows: 1,
    });
  });
});
