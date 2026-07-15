import type { RedisLockService } from '../redis/redis-lock.service';
import type { AssetCandlesCacheService } from './asset-candles-cache.service';
import type { AssetCandlesResponse } from './asset-candles.service';
import type { CandleCacheKeyInput } from './asset-candles-cache.keys';
import {
  AssetCandlesSingleFlightService,
  CandleSingleFlightWaitTimeoutError,
} from './asset-candles-single-flight.service';

const key: CandleCacheKeyInput = {
  assetId: 'asset-1',
  range: '1d',
  interval: '5m',
  limit: 100,
  requestedDate: '2026-07-11',
};
const response = {
  success: true,
  data: { marker: 'loaded' },
} as unknown as AssetCandlesResponse;

describe('AssetCandlesSingleFlightService', () => {
  const create = (
    options: {
      enabled?: boolean;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      generation?: () => number;
    } = {},
  ) => {
    const getWithContext = jest.fn().mockResolvedValue({ status: 'miss' });
    const setIfOwnerAndGeneration = jest
      .fn()
      .mockResolvedValue({ status: 'stored' });
    const cache = {
      isEnabled: jest.fn(() => options.enabled ?? true),
      resolveContext: jest.fn((input: CandleCacheKeyInput) =>
        Promise.resolve(
          options.enabled === false
            ? { status: 'disabled' }
            : {
                status: 'resolved',
                context: {
                  input,
                  generation: options.generation?.() ?? 0,
                  generationKey: `gen:${input.assetId}`,
                  dataKey: `data:${input.assetId}:g${options.generation?.() ?? 0}`,
                },
              },
        ),
      ),
      getWithContext,
      get: getWithContext,
      setIfOwnerAndGeneration,
      set: setIfOwnerAndGeneration,
    };
    const locks = {
      acquire: jest.fn().mockResolvedValue({
        status: 'acquired',
        lock: { key: 'lock', token: 'owner-token', ttlMs: 300 },
      }),
      extend: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const service = new AssetCandlesSingleFlightService(
      cache as unknown as AssetCandlesCacheService,
      locks as unknown as RedisLockService,
      {
        lockTtlMs: 300,
        waitTimeoutMs: 350,
        pollIntervalMs: 100,
        renewIntervalMs: 100,
      },
      options.now ?? Date.now,
      options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    );
    return { cache, locks, service };
  };

  afterEach(() => jest.useRealTimers());

  it('runs one local loader for 20 concurrent requests and clears the map', async () => {
    const { service } = create({ enabled: false });
    const loader = jest.fn().mockResolvedValue(response);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.getOrLoad({ cacheKeyInput: key, loader }),
      ),
    );
    expect(results).toHaveLength(20);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(service.getInFlightCount()).toBe(0);
  });

  it('keeps different keys independent', async () => {
    const { service } = create({ enabled: false });
    const loader = jest.fn().mockResolvedValue(response);
    await Promise.all([
      service.getOrLoad({ cacheKeyInput: key, loader }),
      service.getOrLoad({
        cacheKeyInput: { ...key, assetId: 'asset-2' },
        loader,
      }),
    ]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('returns a cache hit without locking or loading', async () => {
    const { cache, locks, service } = create();
    cache.get.mockResolvedValueOnce({ status: 'fresh', value: response });
    const loader = jest.fn();
    await expect(
      service.getOrLoad({ cacheKeyInput: key, loader }),
    ).resolves.toBe(response);
    expect(loader).not.toHaveBeenCalled();
    expect(locks.acquire).not.toHaveBeenCalled();
  });

  it('double-checks after lock, stores success, and releases its own lock', async () => {
    const { cache, locks, service } = create();
    const loader = jest.fn().mockResolvedValue(response);
    await expect(
      service.getOrLoad({ cacheKeyInput: key, loader }),
    ).resolves.toBe(response);
    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.setIfOwnerAndGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ dataKey: 'data:asset-1:g0' }),
      response,
      { lockKey: 'lock', lockToken: 'owner-token' },
    );
    expect(locks.release).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'owner-token' }),
    );
  });

  it('returns loader success when cache storage fails operationally', async () => {
    const { cache, service } = create();
    cache.set.mockResolvedValueOnce({ status: 'error' });
    await expect(
      service.getOrLoad({
        cacheKeyInput: key,
        loader: () => Promise.resolve(response),
      }),
    ).resolves.toBe(response);
  });

  it('shares loader failure, does not cache, releases, and permits retry', async () => {
    const { cache, locks, service } = create();
    const failure = new Error('provider failed');
    const loader = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(response);
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        service.getOrLoad({ cacheKeyInput: key, loader }),
      ),
    );
    expect(
      settled.every(
        (item) => item.status === 'rejected' && item.reason === failure,
      ),
    ).toBe(true);
    expect(cache.set).not.toHaveBeenCalled();
    expect(locks.release).toHaveBeenCalled();
    expect(service.getInFlightCount()).toBe(0);
    await expect(
      service.getOrLoad({ cacheKeyInput: key, loader }),
    ).resolves.toBe(response);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('retains local single-flight when distributed Redis locking fails', async () => {
    const { locks, service } = create();
    locks.acquire.mockResolvedValue({ status: 'error' });
    const loader = jest.fn().mockResolvedValue(response);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        service.getOrLoad({ cacheKeyInput: key, loader }),
      ),
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('polls a remote owner and returns the populated cache value', async () => {
    const { cache, locks, service } = create({
      sleep: () => Promise.resolve(undefined),
    });
    locks.acquire.mockResolvedValueOnce({ status: 'busy' });
    cache.get
      .mockResolvedValueOnce({ status: 'miss' })
      .mockResolvedValueOnce({ status: 'fresh', value: response });
    const loader = jest.fn();
    await expect(
      service.getOrLoad({ cacheKeyInput: key, loader }),
    ).resolves.toBe(response);
    expect(loader).not.toHaveBeenCalled();
  });

  it('times out after bounded polling and one failed reacquire', async () => {
    let now = 0;
    const { locks, service } = create({
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    locks.acquire.mockResolvedValue({ status: 'busy' });
    await expect(
      service.getOrLoad({ cacheKeyInput: key, loader: jest.fn() }),
    ).rejects.toBeInstanceOf(CandleSingleFlightWaitTimeoutError);
    expect(locks.acquire.mock.calls.length).toBeGreaterThan(1);
  });

  it('returns stale after the shorter waiter bound while another owner refreshes', async () => {
    let now = 0;
    const { cache, locks, service } = create({
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    cache.get.mockResolvedValue({ status: 'stale', value: response });
    locks.acquire.mockResolvedValue({ status: 'busy' });
    await expect(
      service.getOrLoad({
        cacheKeyInput: key,
        staleWaiterMaxWaitMs: 100,
        loader: jest.fn(),
      }),
    ).resolves.toBe(response);
    expect(now).toBe(100);
  });

  it('renews long-running owner locks and clears the renewal timer', async () => {
    jest.useFakeTimers();
    const { locks, service } = create();
    let resolveLoader!: (value: AssetCandlesResponse) => void;
    const loader = () =>
      new Promise<AssetCandlesResponse>((resolve) => (resolveLoader = resolve));
    const loading = service.getOrLoad({ cacheKeyInput: key, loader });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(100);
    expect(locks.extend).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'owner-token' }),
      300,
    );
    resolveLoader(response);
    await loading;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not join a pre-invalidation loader or store it into the new generation', async () => {
    let generation = 0;
    const stored: number[] = [];
    const { cache, service } = create({ generation: () => generation });
    cache.setIfOwnerAndGeneration.mockImplementation(
      (context: { generation: number }) => {
        if (context.generation !== generation) {
          return Promise.resolve({ status: 'skipped_generation_changed' });
        }
        stored.push(context.generation);
        return Promise.resolve({ status: 'stored' });
      },
    );
    let resolveOld!: (value: AssetCandlesResponse) => void;
    const oldLoader = jest.fn(
      () =>
        new Promise<AssetCandlesResponse>((resolve) => (resolveOld = resolve)),
    );
    const newLoader = jest.fn().mockResolvedValue(response);
    const oldRequest = service.getOrLoad({
      cacheKeyInput: key,
      loader: oldLoader,
    });
    await Promise.resolve();
    await Promise.resolve();
    generation = 1;
    const newRequest = service.getOrLoad({
      cacheKeyInput: key,
      loader: newLoader,
    });
    await expect(newRequest).resolves.toBe(response);
    resolveOld(response);
    await expect(oldRequest).resolves.toBe(response);

    expect(oldLoader).toHaveBeenCalledTimes(1);
    expect(newLoader).toHaveBeenCalledTimes(1);
    expect(stored).toEqual([1]);
  });

  it('does not cache after renewal reports ownership loss', async () => {
    jest.useFakeTimers();
    const { cache, locks, service } = create();
    locks.extend.mockResolvedValueOnce(false);
    let resolveLoader!: (value: AssetCandlesResponse) => void;
    const loading = service.getOrLoad({
      cacheKeyInput: key,
      loader: () =>
        new Promise<AssetCandlesResponse>(
          (resolve) => (resolveLoader = resolve),
        ),
    });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(100);
    resolveLoader(response);
    await expect(loading).resolves.toBe(response);
    expect(cache.setIfOwnerAndGeneration).not.toHaveBeenCalled();
  });

  it('waits for an in-flight renewal result before deciding to cache', async () => {
    jest.useFakeTimers();
    const { cache, locks, service } = create();
    let resolveRenewal!: (value: boolean) => void;
    locks.extend.mockReturnValueOnce(
      new Promise<boolean>((resolve) => (resolveRenewal = resolve)),
    );
    let resolveLoader!: (value: AssetCandlesResponse) => void;
    const loading = service.getOrLoad({
      cacheKeyInput: key,
      loader: () =>
        new Promise<AssetCandlesResponse>(
          (resolve) => (resolveLoader = resolve),
        ),
    });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(100);
    resolveLoader(response);
    await Promise.resolve();
    expect(cache.setIfOwnerAndGeneration).not.toHaveBeenCalled();
    resolveRenewal(false);
    await expect(loading).resolves.toBe(response);
    expect(cache.setIfOwnerAndGeneration).not.toHaveBeenCalled();
  });

  it('takes over on the first polling cycle after a remote owner releases', async () => {
    const { locks, service } = create({
      sleep: () => Promise.resolve(undefined),
    });
    locks.acquire
      .mockResolvedValueOnce({ status: 'busy' })
      .mockResolvedValueOnce({
        status: 'acquired',
        lock: { key: 'lock', token: 'new-owner', ttlMs: 300 },
      });
    const loader = jest.fn().mockResolvedValue(response);
    await expect(
      service.getOrLoad({ cacheKeyInput: key, loader }),
    ).resolves.toBe(response);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(locks.acquire).toHaveBeenCalledTimes(2);
  });
});
