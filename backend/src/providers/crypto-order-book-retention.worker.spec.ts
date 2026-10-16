jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{
    sqltag: unknown;
    raw: unknown;
  }>('@prisma/client/runtime/client');
  return { Prisma: { sql: runtime.sqltag, raw: runtime.raw } };
});
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../ops/ops-job-lock.service', () => ({
  OpsJobLockService: class {},
}));
jest.mock('../ops/ops-job-run.service', () => ({ OpsJobRunService: class {} }));
import { Logger } from '@nestjs/common';
import {
  CRYPTO_ORDER_BOOK_HISTORY_TABLES,
  CryptoOrderBookRetentionWorker,
  cryptoOrderBookDeleteBefore,
  cryptoOrderBookRetentionBatchSql,
} from './crypto-order-book-retention.worker';
import { cryptoOrderBookHistoryConfig } from './crypto-order-book-history.config';
import { RETENTION_FAILING_AFTER } from '../futures/futures-retention-health';

const NOW = new Date('2026-10-16T07:00:30.500Z');
const HOUR = 3_600_000;
const timeout = () =>
  Object.assign(new Error('canceled'), {
    code: 'P2010',
    meta: {
      driverAdapterError: {
        cause: { kind: 'postgres', originalCode: '57014' },
      },
    },
  });
const events = (spy: jest.SpyInstance) =>
  spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('crypto order book history configuration', () => {
  it('is off by default; retention follows recording unless set; strict values', () => {
    expect(cryptoOrderBookHistoryConfig({})).toMatchObject({
      enabled: false,
      retentionEnabled: false,
      bucketMs: 60_000,
      maxBookAgeMs: 5_000,
      retentionHours: 336,
      retentionIntervalMs: 300_000,
      retentionBatchSize: 1_000,
      retentionMaxRowsPerRun: 20_000,
    });
    expect(
      cryptoOrderBookHistoryConfig({
        CRYPTO_ORDER_BOOK_HISTORY_ENABLED: 'true',
      }),
    ).toMatchObject({ enabled: true, retentionEnabled: true });
    // Recording off, retention kept on to drain what was stored.
    expect(
      cryptoOrderBookHistoryConfig({
        CRYPTO_ORDER_BOOK_HISTORY_ENABLED: 'false',
        CRYPTO_ORDER_BOOK_RETENTION_ENABLED: 'true',
      }),
    ).toMatchObject({ enabled: false, retentionEnabled: true });
    for (const env of [
      { CRYPTO_ORDER_BOOK_HISTORY_ENABLED: 'yes' },
      { CRYPTO_ORDER_BOOK_HISTORY_ENABLED: '1' },
      { CRYPTO_ORDER_BOOK_RETENTION_ENABLED: 'TRUE' },
    ])
      expect(() => cryptoOrderBookHistoryConfig(env)).toThrow();
  });

  it('deletes a minute only once all of it is older than 336 hours', () => {
    const cutoff = new Date(+NOW - 336 * HOUR);
    expect(cryptoOrderBookDeleteBefore(cutoff).toISOString()).toBe(
      '2026-10-02T07:00:00.000Z',
    );
    // The minute that contains the cutoff (07:00:00–07:00:59.999) is kept.
    expect(+cryptoOrderBookDeleteBefore(cutoff) + 60_000 > +cutoff).toBe(true);
  });

  it('only ever names the two crypto history tables', () => {
    for (const market of ['spot', 'futures'] as const) {
      const sql = cryptoOrderBookRetentionBatchSql(market, NOW, 1000);
      const text = sql.strings.join('?');
      expect(text.includes(CRYPTO_ORDER_BOOK_HISTORY_TABLES[market])).toBe(
        true,
      );
      for (const other of [
        'asset_orderbook_snapshots',
        'asset_price_snapshots',
        'futures_mark_snapshots',
        'futures_last_price_snapshots',
      ])
        expect(text.includes(other)).toBe(false);
      expect(sql.values).toEqual([NOW, 1000, NOW]);
    }
  });
});

describe('CryptoOrderBookRetentionWorker', () => {
  const saved = { ...process.env };
  const locks = {
    acquireLock: jest.fn(),
    extendLock: jest.fn(),
    releaseLock: jest.fn(),
  };
  const runs = {
    createRunning: jest.fn(),
    recordSucceeded: jest.fn(),
    recordFailed: jest.fn(),
  };
  const deletes: Array<{ market: string; before: Date; limit: number }> = [];
  let remaining: Record<string, number>;
  let failNext: Error | null;
  const tx = {
    $executeRaw: jest.fn((sql: { strings?: string[]; values?: unknown[] }) => {
      if (!sql.strings) return Promise.resolve(0); // SET LOCAL
      if (failNext) {
        const error = failNext;
        failNext = null;
        return Promise.reject(error);
      }
      const market = sql.strings.join('').includes('futures_order_book')
        ? 'futures'
        : 'spot';
      const [before, limit] = sql.values as [Date, number];
      deletes.push({ market, before, limit });
      const count = Math.min(limit, remaining[market]);
      remaining[market] -= count;
      return Promise.resolve(count);
    }),
  };
  const prisma = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('').includes('clock_timestamp')
          ? [{ now: NOW }]
          : [{ spot: null, futures: null }],
      ),
    ),
    $transaction: jest.fn(
      (fn: (client: typeof tx) => Promise<number>, options: unknown) => {
        expect(options).toEqual({ timeout: 10_000 });
        return fn(tx);
      },
    ),
  };
  let worker: CryptoOrderBookRetentionWorker;
  let error: jest.SpyInstance;
  beforeEach(() => {
    process.env.CRYPTO_ORDER_BOOK_RETENTION_ENABLED = 'true';
    for (const mock of [...Object.values(locks), ...Object.values(runs)])
      mock.mockReset();
    locks.acquireLock.mockResolvedValue({
      acquired: true,
      ownerId: 'owner',
      lockKey: 'crypto_order_book_retention:current',
    });
    locks.extendLock.mockResolvedValue(true);
    locks.releaseLock.mockResolvedValue(true);
    runs.createRunning.mockResolvedValue({ id: 'run', startedAt: NOW });
    deletes.length = 0;
    remaining = { spot: 0, futures: 0 };
    failNext = null;
    worker = new CryptoOrderBookRetentionWorker(
      prisma as never,
      locks as never,
      runs as never,
    );
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  it('deletes both tables in bounded batches under one Ops lease and records the run', async () => {
    remaining = { spot: 2500, futures: 700 };
    const result = await worker.run();
    expect(locks.acquireLock).toHaveBeenCalledWith({
      jobName: 'crypto_order_book_retention',
      lockKey: 'crypto_order_book_retention:current',
      ttlSeconds: 60,
    });
    expect(deletes.map((d) => [d.market, d.limit])).toEqual([
      ['spot', 1000],
      ['spot', 1000],
      ['spot', 1000],
      ['futures', 1000],
    ]);
    expect(
      deletes.every(
        (d) => d.before.toISOString() === '2026-10-02T07:00:00.000Z',
      ),
    ).toBe(true);
    expect(locks.extendLock).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      deletedCount: 3200,
      deleted: { spot: 2500, futures: 700 },
      batchCount: 4,
      batchLimitReached: false,
    });
    const [succeededRun, succeeded] = runs.recordSucceeded.mock
      .calls[0] as unknown as [
      unknown,
      { resultJson: { deletedCount: number } },
    ];
    expect(succeededRun).toEqual({ id: 'run', startedAt: NOW });
    expect(succeeded.resultJson.deletedCount).toBe(3200);
    expect(locks.releaseLock).toHaveBeenCalledWith({
      lockKey: 'crypto_order_book_retention:current',
      ownerId: 'owner',
    });
    expect(worker.getStatus()).toMatchObject({
      enabled: true,
      retentionHours: 336,
      failing: false,
      backlog: false,
    });
  });

  it('caps a run at 20,000 rows; ten capped runs in a row are a backlog alert', async () => {
    remaining = { spot: 1_000_000, futures: 0 };
    for (let run = 0; run < 10; run++) {
      const result = await worker.run();
      expect(result).toMatchObject({
        deletedCount: 20_000,
        batchLimitReached: true,
      });
    }
    expect(worker.getStatus()).toMatchObject({
      backlog: true,
      saturatedRuns: 10,
    });
  });

  it('a run another instance holds is skipped without touching rows', async () => {
    locks.acquireLock.mockResolvedValue({ acquired: false });
    remaining = { spot: 10, futures: 10 };
    expect(await worker.run()).toBeUndefined();
    expect(deletes).toEqual([]);
    expect(runs.createRunning).not.toHaveBeenCalled();
  });

  it('never runs twice at once in one process', async () => {
    remaining = { spot: 10, futures: 0 };
    const [first, second] = await Promise.all([worker.run(), worker.run()]);
    expect(first).toMatchObject({ deletedCount: 10 });
    expect(second).toBeUndefined();
    expect(locks.acquireLock).toHaveBeenCalledTimes(1);
  });

  it('records a failure kind, alerts after three failed runs and recovers', async () => {
    remaining = { spot: 10, futures: 0 };
    for (let run = 0; run < RETENTION_FAILING_AFTER; run++) {
      failNext = timeout();
      await expect(worker.run()).rejects.toThrow('canceled');
    }
    const [, failed] = runs.recordFailed.mock.calls.at(-1) as unknown as [
      unknown,
      { errorCode: string; resultJson: { failureKind: string } },
    ];
    expect(failed.errorCode).toBe('CRYPTO_ORDER_BOOK_RETENTION_FAILED');
    expect(failed.resultJson.failureKind).toBe('statement_timeout');
    expect(worker.getStatus()).toMatchObject({
      failing: true,
      lastFailureKind: 'statement_timeout',
    });
    expect(
      events(error).some(
        (e) =>
          e.event === 'crypto_order_book_retention_failing' &&
          e.job === 'crypto_order_book_retention',
      ),
    ).toBe(true);
    expect(locks.releaseLock).toHaveBeenCalledTimes(RETENTION_FAILING_AFTER);
    expect(await worker.run()).toMatchObject({ deletedCount: 10 });
    expect(worker.getStatus()).toMatchObject({
      failing: false,
      consecutiveFailures: 0,
    });
  });

  it('stops deleting when the Ops lease is lost', async () => {
    remaining = { spot: 5000, futures: 0 };
    locks.extendLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(worker.run()).rejects.toThrow(
      'CRYPTO_ORDER_BOOK_RETENTION_LEASE_LOST',
    );
    expect(deletes.length).toBe(1);
    expect(worker.getStatus().lastFailureKind).toBe('lease_lost');
  });

  it('does nothing while retention is disabled', async () => {
    process.env.CRYPTO_ORDER_BOOK_RETENTION_ENABLED = 'false';
    remaining = { spot: 10, futures: 10 };
    expect(await worker.run()).toBeUndefined();
    expect(locks.acquireLock).not.toHaveBeenCalled();
  });
});
