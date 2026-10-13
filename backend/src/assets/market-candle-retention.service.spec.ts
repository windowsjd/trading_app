jest.mock('./market-candles.repository', () => ({
  MarketCandlesRepository: class MarketCandlesRepository {},
}));

import type { MarketCandlesRepository } from './market-candles.repository';
import {
  MarketCandleRetentionLockLostError,
  MarketCandleRetentionService,
} from './market-candle-retention.service';

describe('MarketCandleRetentionService', () => {
  const now = new Date('2026-07-11T00:00:00.000Z');

  const create = (deletions: Array<number | Error>) => {
    const repository = {
      deleteClosedBeforeBatch: jest.fn(() => {
        const next = deletions.shift() ?? 0;
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      }),
    };
    const yieldToEventLoop = jest.fn().mockResolvedValue(undefined);
    const service = new MarketCandleRetentionService(
      repository as unknown as MarketCandlesRepository,
      { retentionDays: 35, batchSize: 5000, maxBatches: 1000 },
      yieldToEventLoop,
    );
    return { repository, service, yieldToEventLoop };
  };

  it('fixes now once and computes an exact 35-day UTC cutoff', async () => {
    const { repository, service } = create([0]);
    const result = await service.run({ now });
    expect(result).toMatchObject({
      cutoff: new Date('2026-06-06T00:00:00.000Z'),
      retentionDays: 35,
      deletedCount: 0,
      batchCount: 1,
      startedAt: now,
    });
    expect(repository.deleteClosedBeforeBatch).toHaveBeenCalledWith({
      cutoff: new Date('2026-06-06T00:00:00.000Z'),
      interval: '5m',
      limit: 5000,
    });
  });

  it('repeats bounded batches, yields, and totals counts accurately', async () => {
    const { service, yieldToEventLoop } = create([2, 2, 1]);
    const result = await service.run({ now, batchSize: 2 });
    expect(result).toMatchObject({ deletedCount: 5, batchCount: 3 });
    expect(yieldToEventLoop).toHaveBeenCalledTimes(2);
  });

  it('propagates a middle-batch failure after partial committed progress', async () => {
    const failure = new Error('database unavailable');
    const { repository, service } = create([2, failure]);
    await expect(service.run({ now, batchSize: 2 })).rejects.toBe(failure);
    expect(repository.deleteClosedBeforeBatch).toHaveBeenCalledTimes(2);
  });

  it('can safely resume on the next idempotent execution', async () => {
    const first = create([2, new Error('interrupted')]);
    await expect(first.service.run({ now, batchSize: 2 })).rejects.toThrow(
      'interrupted',
    );
    const resumed = create([1]);
    await expect(
      resumed.service.run({ now, batchSize: 2 }),
    ).resolves.toMatchObject({ deletedCount: 1, batchCount: 1 });
  });

  it('prunes the long-range 4h history with its own 180-day cutoff after the 5m prune', async () => {
    const repository = {
      deleteClosedBeforeBatch: jest.fn(
        (params: { interval: string; cutoff: Date }) =>
          Promise.resolve(params.interval === '4h' ? 3 : 0),
      ),
    };
    const futures = {
      deleteClosedBeforeBatch: jest.fn().mockResolvedValue(2),
    };
    const service = new MarketCandleRetentionService(
      repository as unknown as MarketCandlesRepository,
      { retentionDays: 35, batchSize: 5000, maxBatches: 1000 },
      jest.fn().mockResolvedValue(undefined),
      futures,
    );
    const result = await service.run({ now });
    expect(result.cutoff).toEqual(new Date('2026-06-06T00:00:00.000Z'));
    expect(result.deletedCount).toBe(0);
    expect(result.fourHour).toEqual({
      cutoff: new Date('2026-01-12T00:00:00.000Z'),
      retentionDays: 180,
      deletedCount: 3,
      batchCount: 1,
    });
    expect(result.futuresFourHour).toMatchObject({ deletedCount: 2 });
    const intervals = repository.deleteClosedBeforeBatch.mock.calls.map(
      (call) => call[0].interval,
    );
    // 1d/1w are never pruned; 5m keeps its own 35-day cutoff.
    expect(intervals).toEqual(['5m', '4h']);
    expect(futures.deleteClosedBeforeBatch).toHaveBeenCalledWith({
      cutoff: new Date('2026-01-12T00:00:00.000Z'),
      interval: '4h',
      limit: 5000,
    });
  });

  it('refuses a 4h retention shorter than the 96-session KRX window', async () => {
    const { service } = create([0]);
    await expect(
      service.run({ now, fourHourRetentionDays: 120 }),
    ).rejects.toThrow('4h retention must be an integer of at least 150 days.');
  });

  it('stops before another batch when the Ops lock is lost', async () => {
    let owned = true;
    const { service } = create([2, 1]);
    const run = service.run({
      now,
      batchSize: 2,
      isLockOwned: () => owned,
    });
    await Promise.resolve();
    owned = false;
    await expect(run).rejects.toBeInstanceOf(
      MarketCandleRetentionLockLostError,
    );
  });
});
