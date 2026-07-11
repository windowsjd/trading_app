import type { KisRateLimitConfig } from './kis-rate-limit.config';
import type { KisRateLimiterService } from './kis-rate-limiter.service';
import { KisRequestCoordinatorService } from './kis-request-coordinator.service';
import {
  KisRateLimitQueueFullError,
  KisRateLimitShutdownError,
  KisRateLimitWaitTimeoutError,
} from './kis-rate-limit.types';

describe('KisRequestCoordinatorService', () => {
  const config: KisRateLimitConfig = {
    enabled: true,
    environment: 'real',
    restMinIntervalMs: 125,
    oauthMinIntervalMs: 1000,
    maxWaitMs: 1000,
    maxQueueSize: 10,
    appKeyHash: 'hash',
  };

  const create = (overrides: Partial<KisRateLimitConfig> = {}) => {
    const limiter = {
      config: { ...config, ...overrides },
      reserve: jest.fn().mockResolvedValue({ delayMs: 0, mode: 'redis' }),
    };
    return {
      limiter,
      service: new KisRequestCoordinatorService(
        limiter as unknown as KisRateLimiterService,
      ),
    };
  };

  afterEach(() => jest.useRealTimers());

  it('preserves FIFO order', async () => {
    const { service } = create();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((value) =>
        service.acquire('rest').then(() => order.push(value)),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('waits the exact Redis-reserved delay', async () => {
    jest.useFakeTimers();
    const { limiter, service } = create();
    limiter.reserve.mockResolvedValueOnce({ delayMs: 125, mode: 'redis' });
    const acquired = service.acquire('rest');
    let done = false;
    void acquired.then(() => (done = true));
    await jest.advanceTimersByTimeAsync(124);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await acquired;
    expect(done).toBe(true);
  });

  it('rejects when the local queue is full', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const { limiter, service } = create({ maxQueueSize: 1 });
    limiter.reserve.mockImplementationOnce(async () => {
      await blocked;
      return { delayMs: 0, mode: 'redis' };
    });
    const first = service.acquire('rest');
    const second = service.acquire('rest');
    await expect(service.acquire('rest')).rejects.toBeInstanceOf(
      KisRateLimitQueueFullError,
    );
    release();
    await Promise.all([first, second]);
  });

  it('times out without allowing the caller to execute HTTP', async () => {
    jest.useFakeTimers();
    const { limiter, service } = create({ maxWaitMs: 100 });
    limiter.reserve.mockResolvedValueOnce({ delayMs: 1000, mode: 'redis' });
    const http = jest.fn();
    const request = service.acquire('rest').then(http);
    const expectation = expect(request).rejects.toBeInstanceOf(
      KisRateLimitWaitTimeoutError,
    );
    await jest.advanceTimersByTimeAsync(100);
    await expectation;
    expect(http).not.toHaveBeenCalled();
  });

  it('supports cancellation without executing the caller', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const { limiter, service } = create();
    limiter.reserve.mockImplementationOnce(async () => {
      await blocked;
      return { delayMs: 0, mode: 'redis' };
    });
    const controller = new AbortController();
    const http = jest.fn();
    const request = service
      .acquire('rest', { signal: controller.signal })
      .then(http);
    controller.abort();
    await expect(request).rejects.toBeInstanceOf(KisRateLimitWaitTimeoutError);
    release();
    expect(http).not.toHaveBeenCalled();
  });

  it('cleans pending requests and timers on shutdown', async () => {
    jest.useFakeTimers();
    const { limiter, service } = create();
    limiter.reserve.mockResolvedValueOnce({ delayMs: 500, mode: 'redis' });
    const pending = service.acquire('rest');
    const expectation = expect(pending).rejects.toBeInstanceOf(
      KisRateLimitShutdownError,
    );
    await service.onModuleDestroy();
    await expectation;
    expect(jest.getTimerCount()).toBe(0);
  });
});
