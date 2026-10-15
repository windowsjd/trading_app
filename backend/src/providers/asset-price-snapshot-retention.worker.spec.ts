jest.mock('../generated/prisma/client', () => ({ Prisma: {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../ops/ops-job-lock.service', () => ({
  OpsJobLockService: class {},
}));
jest.mock('../ops/ops-job-run.service', () => ({ OpsJobRunService: class {} }));
jest.mock('./asset-price-snapshot-retention.service', () => ({
  AssetPriceSnapshotRetentionService: class {
    deleteBatch(): Promise<unknown> {
      return Promise.resolve({ deleted: 0, scanned: 0, next: null });
    }
  },
}));
import { Logger } from '@nestjs/common';
import { AssetPriceSnapshotRetentionService } from './asset-price-snapshot-retention.service';
import { AssetPriceSnapshotRetentionWorker } from './asset-price-snapshot-retention.worker';
import { assetPriceSnapshotRetentionConfig } from './asset-price-snapshot-retention.config';
import { RETENTION_FAILING_AFTER } from '../futures/futures-retention-health';

const NOW = new Date('2026-10-16T00:00:00Z');
const events = (spy: jest.SpyInstance) =>
  spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const timeout = () =>
  Object.assign(new Error('canceled'), {
    code: 'P2010',
    meta: {
      driverAdapterError: {
        cause: { kind: 'postgres', originalCode: '57014' },
      },
    },
  });
const cursor = (id: string) => ({ effectiveAt: new Date(+NOW - 15e8), id });

describe('asset price snapshot retention configuration', () => {
  it('is off by default with the 14-day policy and strict values', () => {
    expect(assetPriceSnapshotRetentionConfig({})).toEqual({
      enabled: false,
      retentionDays: 14,
      batchSize: 1000,
      maxBatches: 20,
      intervalMs: 300000,
      maxRunMs: 60000,
    });
    expect(
      assetPriceSnapshotRetentionConfig({
        ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED: 'true',
        ASSET_PRICE_SNAPSHOT_RETENTION_DAYS: '30',
      }),
    ).toMatchObject({ enabled: true, retentionDays: 30 });
    for (const env of [
      { ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED: 'yes' },
      // Never shorter than the approved 14-day policy.
      { ASSET_PRICE_SNAPSHOT_RETENTION_DAYS: '13' },
      { ASSET_PRICE_SNAPSHOT_RETENTION_DAYS: '14.5' },
      { ASSET_PRICE_SNAPSHOT_RETENTION_BATCH_SIZE: '10001' },
      { ASSET_PRICE_SNAPSHOT_RETENTION_MAX_BATCHES: '0' },
    ])
      expect(() => assetPriceSnapshotRetentionConfig(env)).toThrow();
  });
});

describe('AssetPriceSnapshotRetentionWorker', () => {
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
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ now: NOW }]),
    asset: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]),
    },
  };
  let worker: AssetPriceSnapshotRetentionWorker;
  let deleteBatch: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    process.env.ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED = 'true';
    for (const mock of [...Object.values(locks), ...Object.values(runs)])
      mock.mockReset();
    locks.acquireLock.mockResolvedValue({
      acquired: true,
      ownerId: 'owner',
      lockKey: 'asset_price_snapshot_retention:current',
    });
    locks.extendLock.mockResolvedValue(true);
    locks.releaseLock.mockResolvedValue(true);
    runs.createRunning.mockResolvedValue({ id: 'run', startedAt: NOW });
    deleteBatch = jest.spyOn(
      AssetPriceSnapshotRetentionService.prototype,
      'deleteBatch',
    );
    worker = new AssetPriceSnapshotRetentionWorker(
      prisma as never,
      locks as never,
      runs as never,
    );
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => {
    worker.onModuleDestroy();
    process.env = { ...saved };
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing while disabled', async () => {
    process.env.ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED = 'false';
    jest.useFakeTimers();
    worker.onModuleInit();
    jest.advanceTimersByTime(3600000);
    expect(await worker.run()).toBeUndefined();
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(deleteBatch).not.toHaveBeenCalled();
  });

  it('sweeps every asset to the cutoff in bounded batches, each from its own cursor', async () => {
    deleteBatch
      .mockResolvedValueOnce({ deleted: 990, scanned: 1000, next: cursor('x') })
      .mockResolvedValueOnce({ deleted: 5, scanned: 7, next: cursor('y') })
      .mockResolvedValueOnce({ deleted: 0, scanned: 0, next: null })
      .mockResolvedValueOnce({ deleted: 3, scanned: 3, next: cursor('z') });
    const result = await worker.run();
    expect(result).toEqual({
      cutoff: '2026-10-02T00:00:00.000Z',
      deletedCount: 998,
      scannedCount: 1010,
      batchCount: 4,
      assetCount: 3,
      assetsSwept: 3,
      batchLimitReached: false,
    });
    expect(
      deleteBatch.mock.calls.map(([scope]) => [
        scope.assetId,
        scope.after?.id ?? null,
      ]),
    ).toEqual([
      ['a1', null],
      ['a1', 'x'],
      ['a2', null],
      ['a3', null],
    ]);
    expect(deleteBatch.mock.calls[0][0]).toMatchObject({
      retentionDays: 14,
      limit: 1000,
      now: NOW,
    });
    expect(runs.recordSucceeded.mock.calls[0][1].resultJson).toEqual(result);
    // The next run continues each asset after the rows it already examined.
    deleteBatch.mockResolvedValue({ deleted: 0, scanned: 0, next: null });
    await worker.run();
    expect(
      deleteBatch.mock.calls.slice(4).map(([scope]) => scope.after?.id ?? null),
    ).toEqual(['y', null, 'z']);
  });

  it('finishes a pass over many assets when each needs only a short batch', async () => {
    prisma.asset.findMany.mockResolvedValueOnce(
      Array.from({ length: 150 }, (_, k) => ({ id: `asset-${k}` })),
    );
    deleteBatch.mockResolvedValue({
      deleted: 2,
      scanned: 12,
      next: cursor('s'),
    });
    const result = await worker.run();
    expect(result?.assetsSwept).toBe(150);
    expect(result?.batchLimitReached).toBe(false);
    expect(worker.getStatus().saturatedRuns).toBe(0);
  });

  it('stops at the per-run row cap and resumes with the same asset', async () => {
    process.env.ASSET_PRICE_SNAPSHOT_RETENTION_MAX_BATCHES = '2';
    deleteBatch.mockResolvedValue({
      deleted: 1000,
      scanned: 1000,
      next: cursor('c'),
    });
    expect((await worker.run())?.batchLimitReached).toBe(true);
    expect(deleteBatch).toHaveBeenCalledTimes(2);
    deleteBatch.mockClear();
    await worker.run();
    expect(deleteBatch.mock.calls[0][0]).toMatchObject({
      assetId: 'a1',
      after: { id: 'c' },
    });
  });

  it('records committed progress and the category of a failed batch; repeated failures mark it failing', async () => {
    deleteBatch
      .mockResolvedValueOnce({ deleted: 400, scanned: 1000, next: cursor('k') })
      .mockRejectedValueOnce(timeout());
    await expect(worker.run()).rejects.toBeTruthy();
    const recorded = runs.recordFailed.mock.calls[0][1];
    expect(recorded.errorCode).toBe('ASSET_PRICE_SNAPSHOT_RETENTION_FAILED');
    expect(recorded.resultJson).toEqual({
      cutoff: '2026-10-02T00:00:00.000Z',
      deletedCount: 400,
      scannedCount: 1000,
      batchCount: 1,
      failureKind: 'statement_timeout',
    });
    deleteBatch.mockRejectedValue(timeout());
    for (let i = 1; i < RETENTION_FAILING_AFTER; i++)
      await expect(worker.run()).rejects.toBeTruthy();
    expect(worker.getStatus()).toMatchObject({
      enabled: true,
      retentionDays: 14,
      failing: true,
      lastFailureKind: 'statement_timeout',
    });
    expect(
      events(error).filter(
        (e) =>
          e.event === 'price_snapshot_retention_failing' &&
          e.job === 'asset_price_snapshot_retention',
      ),
    ).toHaveLength(1);
    deleteBatch.mockResolvedValue({ deleted: 0, scanned: 0, next: null });
    await worker.run();
    expect(worker.getStatus().failing).toBe(false);
  });

  it('stops on a lost lease and never runs a second instance concurrently', async () => {
    locks.extendLock.mockResolvedValue(false);
    await expect(worker.run()).rejects.toThrow(/LEASE_LOST/);
    expect(deleteBatch).not.toHaveBeenCalled();
    expect(runs.recordFailed.mock.calls[0][1].resultJson.failureKind).toBe(
      'lease_lost',
    );
    locks.acquireLock.mockResolvedValue({ acquired: false });
    expect(await worker.run()).toBeUndefined();
    expect(runs.createRunning).toHaveBeenCalledTimes(1);
  });

  it('forgets the cursors after a day, so rows kept for a temporary reason are examined again', async () => {
    jest.useFakeTimers({ now: NOW });
    worker = new AssetPriceSnapshotRetentionWorker(
      prisma as never,
      locks as never,
      runs as never,
    );
    deleteBatch.mockResolvedValue({
      deleted: 0,
      scanned: 5,
      next: cursor('q'),
    });
    await worker.run();
    await worker.run();
    expect(deleteBatch.mock.calls[3][0].after?.id).toBe('q');
    jest.setSystemTime(+NOW + 24 * 3600000);
    await worker.run();
    expect(deleteBatch.mock.calls[6][0].after ?? null).toBeNull();
  });
});
