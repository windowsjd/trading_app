import {
  MarketCandleBackfillLockService,
  buildLockKey,
} from './market-candle-backfill-lock.service';

describe('MarketCandleBackfillLockService', () => {
  const createService = (locks: Partial<Record<string, jest.Mock>>) =>
    new MarketCandleBackfillLockService(locks as never);

  it('acquires a namespaced per-asset/feed lock with the configured TTL', async () => {
    const acquire = jest.fn().mockResolvedValue({
      status: 'acquired',
      lock: { key: buildLockKey('asset-1', '5m'), token: 't', ttlMs: 120_000 },
    });
    const service = createService({ acquire });
    const result = await service.acquire({
      assetId: 'asset-1',
      feed: '5m',
      ttlSeconds: 120,
      renewSeconds: 40,
      now: new Date('2026-07-10T00:00:00Z'),
    });
    expect(acquire).toHaveBeenCalledWith(
      'candles:sync:lock:v1:asset-1:5m',
      120_000,
    );
    expect(result.acquired).toBe(true);
  });

  it.each([
    ['busy', 'busy'],
    ['error', 'unavailable'],
  ] as const)('maps a %s lock store result to %s', async (status, reason) => {
    const service = createService({
      acquire: jest.fn().mockResolvedValue({ status }),
    });
    const result = await service.acquire({
      assetId: 'asset-1',
      feed: '1d',
      ttlSeconds: 120,
      renewSeconds: 40,
    });
    expect(result).toEqual({ acquired: false, reason });
  });

  it('renews only when the renewal interval elapsed and reports lost ownership', async () => {
    const extend = jest.fn().mockResolvedValue(true);
    const service = createService({
      acquire: jest.fn().mockResolvedValue({
        status: 'acquired',
        lock: { key: 'k', token: 't', ttlMs: 120_000 },
      }),
      extend,
    });
    const acquired = await service.acquire({
      assetId: 'asset-1',
      feed: '5m',
      ttlSeconds: 120,
      renewSeconds: 40,
      now: new Date('2026-07-10T00:00:00Z'),
    });
    if (!acquired.acquired) throw new Error('expected acquired');
    const handle = acquired.handle;

    // Too early: no Redis call, ownership assumed.
    await expect(
      service.renewIfDue(handle, new Date('2026-07-10T00:00:39Z')),
    ).resolves.toBe(true);
    expect(extend).not.toHaveBeenCalled();

    // Interval elapsed: extend is called and the renewal clock resets.
    await expect(
      service.renewIfDue(handle, new Date('2026-07-10T00:00:41Z')),
    ).resolves.toBe(true);
    expect(extend).toHaveBeenCalledTimes(1);

    // A failed extension reports lost ownership.
    extend.mockResolvedValueOnce(false);
    await expect(
      service.renewIfDue(handle, new Date('2026-07-10T00:02:00Z')),
    ).resolves.toBe(false);
  });

  it('releases only through the compare-and-delete token path', async () => {
    const release = jest.fn().mockResolvedValue(true);
    const service = createService({
      acquire: jest.fn().mockResolvedValue({
        status: 'acquired',
        lock: { key: 'k', token: 't', ttlMs: 1000 },
      }),
      release,
    });
    const acquired = await service.acquire({
      assetId: 'a',
      feed: '1w',
      ttlSeconds: 10,
      renewSeconds: 5,
    });
    if (!acquired.acquired) throw new Error('expected acquired');
    await service.release(acquired.handle);
    expect(release).toHaveBeenCalledWith(acquired.handle.lock);
  });
});
