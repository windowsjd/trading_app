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
      deleteClosedBeforeBatch: jest.fn(async () => {
        const next = deletions.shift() ?? 0;
        if (next instanceof Error) throw next;
        return next;
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
