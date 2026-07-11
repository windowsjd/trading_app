import { Logger } from '@nestjs/common';
import type { RedisService } from '../../../redis/redis.service';
import { RedisUnavailableError } from '../../../redis/redis.types';
import { readKisRateLimitConfig } from './kis-rate-limit.config';
import { KisRateLimiterService } from './kis-rate-limiter.service';

describe('KisRateLimiterService', () => {
  afterEach(() => jest.restoreAllMocks());

  const create = (env: Record<string, string> = {}, now = () => 1000) => {
    const redis = { eval: jest.fn().mockResolvedValue([0, 1000, 1000]) };
    const config = readKisRateLimitConfig({
      KIS_APP_KEY: 'original-app-key',
      ...env,
    });
    return {
      redis,
      config,
      service: new KisRateLimiterService(
        redis as unknown as RedisService,
        config,
        now,
      ),
    };
  };

  it('uses the atomic Redis reservation delay', async () => {
    const { redis, service } = create();
    redis.eval.mockResolvedValueOnce([125, 1000, 1125]);
    await expect(service.reserve('rest')).resolves.toEqual({
      delayMs: 125,
      mode: 'redis',
    });
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('separates oauth/rest, real/virtual and hides the app key', () => {
    const real = create().service;
    const virtual = create({ KIS_API_ENVIRONMENT: 'virtual' }).service;
    expect(real.keyFor('oauth')).not.toBe(real.keyFor('rest'));
    expect(real.keyFor('rest')).not.toBe(virtual.keyFor('rest'));
    expect(real.keyFor('rest')).not.toContain('original-app-key');
  });

  it('falls back to a bounded local limiter and logs outage/recovery once', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    let now = 1000;
    const { redis, service } = create({}, () => now);
    redis.eval.mockRejectedValue(new RedisUnavailableError('down'));

    await expect(service.reserve('rest')).resolves.toEqual({
      delayMs: 0,
      mode: 'local',
    });
    await expect(service.reserve('rest')).resolves.toEqual({
      delayMs: 125,
      mode: 'local',
    });
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    now += 125;
    redis.eval.mockResolvedValueOnce([0, now, now]);
    await service.reserve('rest');
    expect(Logger.prototype.log).toHaveBeenCalledTimes(1);
  });

  it('maintains separate local oauth and rest buckets', async () => {
    const { redis, service } = create();
    redis.eval.mockRejectedValue(new RedisUnavailableError('down'));
    await service.reserve('oauth');
    await service.reserve('rest');
    await expect(service.reserve('oauth')).resolves.toMatchObject({
      delayMs: 1000,
    });
    await expect(service.reserve('rest')).resolves.toMatchObject({
      delayMs: 125,
    });
  });
});
