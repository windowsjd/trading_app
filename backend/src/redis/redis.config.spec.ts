import { readRedisConfig, RedisConfigError } from './redis.config';
import { DEFAULT_REDIS_CONNECT_TIMEOUT_MS } from './redis.constants';

describe('readRedisConfig', () => {
  it('reads REDIS_URL and connect timeout', () => {
    expect(
      readRedisConfig({
        REDIS_URL: 'redis://localhost:6379',
        REDIS_CONNECT_TIMEOUT_MS: '5000',
      }),
    ).toEqual({
      url: 'redis://localhost:6379',
      connectTimeoutMs: 5000,
    });
  });

  it('defaults the connect timeout and leaves url undefined when unset', () => {
    expect(readRedisConfig({})).toEqual({
      url: undefined,
      connectTimeoutMs: DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    });
  });

  it('trims a blank REDIS_URL to undefined', () => {
    expect(readRedisConfig({ REDIS_URL: '   ' }).url).toBeUndefined();
  });

  it('rejects a non-integer connect timeout', () => {
    expect(() => readRedisConfig({ REDIS_CONNECT_TIMEOUT_MS: 'abc' })).toThrow(
      RedisConfigError,
    );
  });

  it('rejects a non-positive connect timeout', () => {
    expect(() => readRedisConfig({ REDIS_CONNECT_TIMEOUT_MS: '0' })).toThrow(
      RedisConfigError,
    );
  });
});
