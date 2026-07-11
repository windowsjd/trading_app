import type { RedisService } from './redis.service';
import { RedisLockService } from './redis-lock.service';
import { RedisKeyError, RedisUnavailableError } from './redis.types';

describe('RedisLockService', () => {
  const create = () => {
    const redis = {
      setNxPx: jest.fn().mockResolvedValue(true),
      eval: jest.fn().mockResolvedValue(1),
    };
    return {
      redis,
      service: new RedisLockService(redis as unknown as RedisService),
    };
  };

  it('acquires with SET NX PX and a unique opaque token', async () => {
    const { redis, service } = create();
    const result = await service.acquire('candles:lock:v1:key', 30_000);
    expect(result.status).toBe('acquired');
    expect(redis.setNxPx).toHaveBeenCalledWith(
      'candles:lock:v1:key',
      expect.any(String),
      30_000,
    );
  });

  it('reports busy when SET NX does not acquire', async () => {
    const { redis, service } = create();
    redis.setNxPx.mockResolvedValueOnce(false);
    await expect(service.acquire('lock', 1000)).resolves.toEqual({
      status: 'busy',
    });
  });

  it('uses compare-token scripts for release and extend', async () => {
    const { redis, service } = create();
    const lock = { key: 'lock', token: 'owner', ttlMs: 1000 };
    await expect(service.release(lock)).resolves.toBe(true);
    await expect(service.extend(lock, 2000)).resolves.toBe(true);
    expect(redis.eval.mock.calls[0][1]).toEqual(['lock']);
    expect(redis.eval.mock.calls[0][2]).toEqual(['owner']);
    expect(redis.eval.mock.calls[1][2]).toEqual(['owner', '2000']);

    redis.eval.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    await expect(service.release({ ...lock, token: 'wrong' })).resolves.toBe(
      false,
    );
    await expect(service.extend({ ...lock, token: 'wrong' })).resolves.toBe(
      false,
    );
  });

  it('requires a positive TTL and fails closed on operational Redis errors', async () => {
    const { redis, service } = create();
    await expect(service.acquire('lock', 0)).rejects.toBeInstanceOf(
      RedisKeyError,
    );
    redis.setNxPx.mockRejectedValueOnce(new RedisUnavailableError('down'));
    await expect(service.acquire('lock', 1000)).resolves.toEqual({
      status: 'error',
    });
    redis.eval.mockRejectedValue(new RedisUnavailableError('down'));
    const lock = { key: 'lock', token: 'owner', ttlMs: 1000 };
    await expect(service.release(lock)).resolves.toBe(false);
    await expect(service.extend(lock)).resolves.toBe(false);
  });
});
