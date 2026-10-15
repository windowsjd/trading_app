jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { Logger } from '@nestjs/common';
import { DatabaseStorageMonitorService } from './database-storage-monitor.service';
import { readDatabaseStorageMonitorConfig } from './database-storage-monitor.config';

const GB = 1e9;
const HOUR = 3600000;
const events = (spy: jest.SpyInstance) =>
  spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('database storage monitor configuration', () => {
  it('is off by default and accepts only strict values', () => {
    expect(readDatabaseStorageMonitorConfig({})).toMatchObject({
      enabled: false,
      capacityBytes: null,
      intervalMs: 300000,
    });
    expect(
      readDatabaseStorageMonitorConfig({
        DATABASE_STORAGE_MONITOR_ENABLED: 'true',
        DATABASE_STORAGE_CAPACITY_GB: '50',
      }),
    ).toMatchObject({ enabled: true, capacityBytes: 50 * GB });
    for (const env of [
      { DATABASE_STORAGE_MONITOR_ENABLED: 'yes' },
      { DATABASE_STORAGE_CAPACITY_GB: '0' },
      { DATABASE_STORAGE_CAPACITY_GB: '50.5' },
      { DATABASE_STORAGE_CAPACITY_GB: 'fifty' },
      { DATABASE_STORAGE_CAPACITY_GB: '16385' },
    ])
      expect(() => readDatabaseStorageMonitorConfig(env)).toThrow();
  });
});

describe('DatabaseStorageMonitorService', () => {
  const saved = { ...process.env };
  const queryRaw = jest.fn();
  let service: DatabaseStorageMonitorService;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  const size = (bytes: number) =>
    queryRaw.mockResolvedValueOnce([{ bytes: BigInt(Math.round(bytes)) }]);
  beforeEach(() => {
    process.env.DATABASE_STORAGE_MONITOR_ENABLED = 'true';
    process.env.DATABASE_STORAGE_CAPACITY_GB = '50';
    queryRaw.mockReset();
    service = new DatabaseStorageMonitorService({
      $queryRaw: queryRaw,
    } as never);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => {
    service.onModuleDestroy();
    process.env = { ...saved };
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runs no query and starts no timer while disabled', () => {
    jest.useFakeTimers();
    process.env.DATABASE_STORAGE_MONITOR_ENABLED = 'false';
    service.onModuleInit();
    jest.advanceTimersByTime(3 * HOUR);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(service.getStatus().level).toBe('unknown');
  });

  it('samples every five minutes after a short start delay', async () => {
    jest.useFakeTimers();
    queryRaw.mockResolvedValue([{ bytes: BigInt(9 * GB) }]);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(29999);
    expect(queryRaw).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // The five-minute interval counts from start: 30 s, 300 s, 600 s, ...
    await jest.advanceTimersByTimeAsync(270000);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(300000);
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it.each([
    [29.9, 'ok'],
    [30, 'warning'],
    [40, 'action_required'],
    [45, 'critical'],
  ])('%s GB of 50 GB is %s', async (gb, level) => {
    size(gb * GB);
    await service.sample(Date.parse('2026-10-16T00:00:00Z'));
    const status = service.getStatus(Date.parse('2026-10-16T00:00:01Z'));
    expect(status.level).toBe(level);
    expect(status.usedPercent).toBe(+(gb * 2).toFixed(1));
  });

  it('reports level changes once and repeats only by severity', async () => {
    let now = Date.parse('2026-10-16T00:00:00Z');
    size(25 * GB);
    await service.sample(now);
    size(31 * GB);
    await service.sample((now += 300000));
    size(31 * GB);
    await service.sample((now += 300000));
    expect(
      events(warn).filter((e) => e.event === 'db_storage_level'),
    ).toHaveLength(1);
    size(46 * GB);
    await service.sample((now += 300000));
    size(46 * GB);
    await service.sample((now += 300000));
    // Critical repeats on every sample.
    expect(
      events(error).filter(
        (e) => e.event === 'db_storage_level' && e.level === 'critical',
      ),
    ).toHaveLength(2);
  });

  it('measures daily growth only over at least an hour and runway only over six hours', async () => {
    const start = Date.parse('2026-10-16T00:00:00Z');
    size(20 * GB);
    await service.sample(start);
    size(20.01 * GB);
    await service.sample(start + 30 * 60000);
    expect(service.getStatus(start + 30 * 60000).growthBytesPerDay).toBeNull();
    size(20.1 * GB);
    await service.sample(start + HOUR);
    const early = service.getStatus(start + HOUR);
    expect(early.growthBytesPerDay).toBe(2.4 * GB);
    expect(early.daysUntil80Percent).toBeNull();
    // 1 GB per 6 h = 4 GB/day: 40 GB (80 %) is (40 - 21) / 4 = 4.8 days away.
    size(21 * GB);
    await service.sample(start + 6 * HOUR);
    const later = service.getStatus(start + 6 * HOUR);
    expect(later.growthBytesPerDay).toBe(4 * GB);
    expect(later.daysUntil80Percent).toBe(4.8);
    expect(later.daysUntilFull).toBe(7.3);
    expect(
      events(warn).some((e) => e.event === 'db_storage_runway_short'),
    ).toBe(true);
  });

  it('keeps size and growth without a configured capacity, but no percentage', async () => {
    delete process.env.DATABASE_STORAGE_CAPACITY_GB;
    size(9 * GB);
    await service.sample(Date.parse('2026-10-16T00:00:00Z'));
    const status = service.getStatus(Date.parse('2026-10-16T00:00:00Z'));
    expect(status.capacityConfigured).toBe(false);
    expect(status.databaseBytes).toBe(9 * GB);
    expect(status.usedPercent).toBeNull();
    expect(status.level).toBe('unknown');
  });

  it('counts max_wal_size on top of the database size as WAL headroom', async () => {
    queryRaw.mockResolvedValueOnce([
      { bytes: BigInt(28.8 * GB), wal: BigInt(1.28 * GB) },
    ]);
    await service.sample(Date.parse('2026-10-16T00:00:00Z'));
    const status = service.getStatus(Date.parse('2026-10-16T00:00:01Z'));
    // 28.8 GB alone is 57.6 %; with 1.28 GB of WAL it crosses 60 %.
    expect(status.databaseBytes).toBe(28.8 * GB);
    expect(status.walReserveBytes).toBe(1.28 * GB);
    expect(status.usedPercent).toBe(60.2);
    expect(status.level).toBe('warning');
  });

  it('marks the level stale after fifteen minutes without a successful sample', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-16T00:00:00Z') });
    queryRaw.mockRejectedValue(new Error('timeout'));
    service.onModuleInit();
    const start = Date.now();
    await jest.advanceTimersByTimeAsync(30000);
    expect(service.getStatus(start + 30000).sampleStale).toBe(false);
    // First sample due at +30 s, so fifteen minutes later it is stale.
    expect(service.getStatus(start + 30000 + 15 * 60000).sampleStale).toBe(
      false,
    );
    expect(service.getStatus(start + 30001 + 15 * 60000).sampleStale).toBe(
      true,
    );
    queryRaw.mockReset();
    size(10 * GB);
    await service.sample(start + 20 * 60000);
    expect(service.getStatus(start + 21 * 60000).sampleStale).toBe(false);
    expect(service.getStatus(start + 36 * 60000).sampleStale).toBe(true);
  });

  it('logs no error for an unknown level when no capacity is configured', async () => {
    delete process.env.DATABASE_STORAGE_CAPACITY_GB;
    size(9 * GB);
    await service.sample(Date.parse('2026-10-16T00:00:00Z'));
    size(9 * GB);
    await service.sample(Date.parse('2026-10-16T00:05:00Z'));
    expect(events(error)).toEqual([]);
  });

  it('records a failed sample by category without driver text', async () => {
    queryRaw.mockRejectedValueOnce(
      Object.assign(new Error('x'), {
        cause: { kind: 'DatabaseNotReachable', host: 'db.internal' },
      }),
    );
    await service.sample();
    expect(service.getStatus().lastSampleFailureKind).toBe('connection');
    expect(
      events(warn).some((e) => e.event === 'db_storage_sample_failed'),
    ).toBe(true);
    expect(warn.mock.calls.map(([l]) => String(l)).join('\n')).not.toContain(
      'db.internal',
    );
  });
});
