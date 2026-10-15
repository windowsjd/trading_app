jest.mock('../generated/prisma/client', () => ({ Prisma: {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../ops/ops-job-lock.service', () => ({
  OpsJobLockService: class {},
}));
jest.mock('../ops/ops-job-run.service', () => ({ OpsJobRunService: class {} }));
import { Logger } from '@nestjs/common';
import { FuturesMarkRetentionService } from './futures-mark-retention.service';
import { FuturesLastPriceRetentionService } from './futures-last-price-retention.service';
import {
  RETENTION_BACKLOG_AFTER,
  RETENTION_FAILING_AFTER,
} from './futures-retention-health';

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

describe.each([
  [
    'futures_mark_retention',
    FuturesMarkRetentionService,
    'FUTURES_MARK_RETENTION_ENABLED',
    'FUTURES_MARK_RETENTION_FAILED',
  ],
  [
    'futures_last_price_retention',
    FuturesLastPriceRetentionService,
    'FUTURES_LAST_PRICE_RETENTION_ENABLED',
    'FUTURES_LAST_PRICE_RETENTION_FAILED',
  ],
] as const)('%s run health', (job, Service, flag, errorCode) => {
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
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ now: new Date('2026-10-16T00:00:00Z') }]),
  };
  let service: FuturesMarkRetentionService | FuturesLastPriceRetentionService;
  let deleteBatch: jest.SpyInstance;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    process.env[flag] = 'true';
    for (const mock of [...Object.values(locks), ...Object.values(runs)])
      mock.mockReset();
    locks.acquireLock.mockResolvedValue({
      acquired: true,
      ownerId: 'owner',
      lockKey: `${job}:current`,
    });
    locks.extendLock.mockResolvedValue(true);
    locks.releaseLock.mockResolvedValue(true);
    runs.createRunning.mockResolvedValue({ id: 'run', startedAt: new Date() });
    service = new Service(prisma as never, locks as never, runs as never);
    deleteBatch = jest.spyOn(service, 'deleteBatch');
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  it('records committed progress and the failure category of a timed-out batch; repeated failures mark it failing', async () => {
    deleteBatch.mockResolvedValueOnce(1000).mockRejectedValueOnce(timeout());
    await expect(service.run()).rejects.toBeTruthy();
    expect(runs.recordFailed).toHaveBeenCalledTimes(1);
    const recorded = runs.recordFailed.mock.calls[0][1];
    expect(recorded.errorCode).toBe(errorCode);
    expect(recorded.resultJson).toEqual({
      cutoff: '2026-10-15T00:00:00.000Z',
      deletedCount: 1000,
      batchCount: 1,
      failureKind: 'statement_timeout',
    });
    expect(service.getStatus().failing).toBe(false);
    deleteBatch.mockRejectedValue(timeout());
    for (let i = 1; i < RETENTION_FAILING_AFTER; i++)
      await expect(service.run()).rejects.toBeTruthy();
    const status = service.getStatus();
    expect(status.consecutiveFailures).toBe(RETENTION_FAILING_AFTER);
    expect(status.failing).toBe(true);
    expect(status.lastFailureKind).toBe('statement_timeout');
    expect(
      events(error).filter((e) => e.event === 'futures_retention_failing'),
    ).toHaveLength(1);
    deleteBatch.mockResolvedValue(3);
    expect((await service.run())?.deletedCount).toBe(3);
    expect(service.getStatus().failing).toBe(false);
    expect(service.getStatus().consecutiveFailures).toBe(0);
  });

  it('stops deleting on a lost lease and records lease_lost', async () => {
    locks.extendLock.mockResolvedValue(false);
    await expect(service.run()).rejects.toThrow(/LEASE_LOST/);
    expect(deleteBatch).not.toHaveBeenCalled();
    expect(runs.recordFailed.mock.calls[0][1].resultJson.failureKind).toBe(
      'lease_lost',
    );
    expect(service.getStatus().lastFailureKind).toBe('lease_lost');
  });

  it(`flags a backlog after ${RETENTION_BACKLOG_AFTER} consecutive runs at the per-run cap`, async () => {
    deleteBatch.mockResolvedValue(1000);
    for (let i = 0; i < RETENTION_BACKLOG_AFTER; i++) {
      expect(service.getStatus().backlog).toBe(false);
      expect((await service.run())?.batchLimitReached).toBe(true);
    }
    expect(service.getStatus().backlog).toBe(true);
    expect(
      events(warn).filter((e) => e.event === 'futures_retention_backlog'),
    ).toHaveLength(1);
    deleteBatch.mockResolvedValue(10);
    await service.run();
    expect(service.getStatus().backlog).toBe(false);
    expect(service.getStatus().saturatedRuns).toBe(0);
  });

  it('records nothing while another instance holds the lease', async () => {
    locks.acquireLock.mockResolvedValue({ acquired: false });
    expect(await service.run()).toBeUndefined();
    expect(runs.createRunning).not.toHaveBeenCalled();
    expect(service.getStatus().consecutiveFailures).toBe(0);
    expect(service.getStatus().lastSucceededAt).toBeNull();
  });

  it('classifies disk-full failures and alerts with fixed fields only', async () => {
    deleteBatch.mockRejectedValue(
      Object.assign(new Error('full'), {
        cause: {
          kind: 'postgres',
          originalCode: '53100',
          originalMessage: 'could not extend file "base/1/2": No space left',
        },
      }),
    );
    await expect(service.run()).rejects.toBeTruthy();
    expect(service.getStatus().lastFailureKind).toBe('disk_full');
    expect(events(error).some((e) => e.event === 'db_disk_full')).toBe(true);
    expect(
      error.mock.calls.map(([line]) => String(line)).join('\n'),
    ).not.toContain('base/1/2');
  });
});

describe('Mark retention schedule', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('first runs half a period after start (Last retention runs on the full period), then every period', () => {
    jest.useFakeTimers();
    process.env.FUTURES_MARK_RETENTION_ENABLED = 'true';
    const service = new FuturesMarkRetentionService(
      {} as never,
      {} as never,
      {} as never,
    );
    const run = jest.spyOn(service, 'run').mockResolvedValue(undefined);
    service.onModuleInit();
    jest.advanceTimersByTime(29999);
    expect(run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60000);
    expect(run).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
    jest.advanceTimersByTime(120000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
