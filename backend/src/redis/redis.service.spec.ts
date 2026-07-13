import { Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import {
  RawRedisClient,
  RedisKeyError,
  RedisUnavailableError,
} from './redis.types';

type Listener = (...args: unknown[]) => void;

class FakeRedisClient implements RawRedisClient {
  status = 'wait';
  private readonly listeners = new Map<string, Listener[]>();

  connect = jest.fn((): Promise<void> => {
    this.status = 'ready';
    return Promise.resolve();
  });
  get = jest.fn((): Promise<string | null> => Promise.resolve(null));
  set = jest.fn((): Promise<string | null> => Promise.resolve('OK'));
  del = jest.fn((): Promise<number> => Promise.resolve(1));
  incr = jest.fn((): Promise<number> => Promise.resolve(1));
  expire = jest.fn((): Promise<number> => Promise.resolve(1));
  ttl = jest.fn((): Promise<number> => Promise.resolve(30));
  ping = jest.fn((): Promise<string> => Promise.resolve('PONG'));
  eval = jest.fn((): Promise<unknown> => Promise.resolve(1));
  publish = jest.fn((): Promise<number> => Promise.resolve(1));
  zrangebyscore = jest.fn((): Promise<string[]> => Promise.resolve([]));
  zrem = jest.fn((): Promise<number> => Promise.resolve(1));
  quit = jest.fn((): Promise<string> => Promise.resolve('OK'));
  disconnect = jest.fn((): void => undefined);

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

const SECRET_URL = 'redis://app:super-secret-password@redis-host:6379';

const createHarness = (client: FakeRedisClient = new FakeRedisClient()) => {
  const factory = jest.fn(() => client);
  const service = new RedisService(
    { url: SECRET_URL, connectTimeoutMs: 3000, commandTimeoutMs: 1000 },
    factory,
  );
  return { client, factory, service };
};

describe('RedisService', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('connects the underlying client only once under concurrent connect calls', async () => {
    const { client, factory, service } = createHarness();

    await Promise.all([
      service.connect(),
      service.connect(),
      service.connect(),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(service.isConnected()).toBe(true);
  });

  it('reuses one connection across sequential operations', async () => {
    const { client, service } = createHarness();

    await service.get('a');
    await service.get('b');

    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('delegates get/setWithTtl/delete/increment to the client', async () => {
    const { client, service } = createHarness();
    client.get.mockResolvedValueOnce('value');
    client.del.mockResolvedValueOnce(2);
    client.incr.mockResolvedValueOnce(7);

    await expect(service.get('k')).resolves.toBe('value');
    await service.setWithTtl('k', 'v', 30);
    await expect(service.delete('k')).resolves.toBe(2);
    await expect(service.increment('gen')).resolves.toBe(7);

    expect(client.get).toHaveBeenCalledWith('k');
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 30);
    expect(client.del).toHaveBeenCalledWith('k');
    expect(client.incr).toHaveBeenCalledWith('gen');
  });

  it('delegates live candle Pub/Sub and exact sorted-set operations', async () => {
    const { client, service } = createHarness();
    client.zrangebyscore.mockResolvedValueOnce(['state-1']);
    await expect(service.publish('candles:live:v1:fanout', '{}')).resolves.toBe(
      1,
    );
    await expect(
      service.zrangeByScore('candles:live:v1:active', '-inf', 100),
    ).resolves.toEqual(['state-1']);
    await expect(
      service.removeFromSortedSet('candles:live:v1:active', ['state-1']),
    ).resolves.toBe(1);
    expect(client.zrem).toHaveBeenCalledWith(
      'candles:live:v1:active',
      'state-1',
    );
  });

  it('quits the client on module destroy', async () => {
    const { client, service } = createHarness();
    await service.connect();

    await service.onModuleDestroy();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(service.isConnected()).toBe(false);
  });

  it('does not create or quit a client when never used', async () => {
    const { client, factory, service } = createHarness();

    await service.onModuleDestroy();

    expect(factory).not.toHaveBeenCalled();
    expect(client.quit).not.toHaveBeenCalled();
  });

  it('handles a client error event without throwing and logs one warning', async () => {
    const { client, service } = createHarness();
    await service.connect();

    expect(() =>
      client.emit(
        'error',
        Object.assign(new Error('boom'), { code: 'ECONNRESET' }),
      ),
    ).not.toThrow();
    expect(service.isConnected()).toBe(false);

    // Repeated errors during the same outage do not flood the log.
    client.emit('error', new Error('boom again'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects operations with RedisUnavailableError when connecting fails', async () => {
    const client = new FakeRedisClient();
    client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const { service } = createHarness(client);

    await expect(service.get('k')).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    // A later call may retry a fresh connect instead of a cached rejection.
    await expect(service.get('k')).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('fails open with RedisUnavailableError when REDIS_URL is missing', async () => {
    const service = new RedisService({
      url: undefined,
      connectTimeoutMs: 3000,
      commandTimeoutMs: 1000,
    });

    await expect(service.get('k')).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('never logs the Redis URL or password', async () => {
    const client = new FakeRedisClient();
    client.connect.mockRejectedValue(
      new Error('connect ECONNREFUSED redis-host:6379'),
    );
    const { service } = createHarness(client);

    await expect(service.get('k')).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );

    const warnCalls = warnSpy.mock.calls as unknown[][];
    const logCalls = logSpy.mock.calls as unknown[][];
    const allLogs = [...warnCalls, ...logCalls]
      .flat()
      .map((arg) => String(arg))
      .join(' ');
    expect(allLogs).not.toContain('super-secret-password');
    expect(allLogs).not.toContain(SECRET_URL);
  });

  it('rejects an empty key as a programmer error, not a swallowed miss', async () => {
    const { service } = createHarness();

    await expect(service.get('')).rejects.toBeInstanceOf(RedisKeyError);
  });

  it('validates keys before attempting an unavailable connection', async () => {
    const client = new FakeRedisClient();
    client.connect.mockRejectedValue(new Error('down'));
    const { service } = createHarness(client);
    await expect(service.get('')).rejects.toBeInstanceOf(RedisKeyError);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('rejects a non-positive TTL as a programmer error', async () => {
    const { service } = createHarness();

    await expect(service.setWithTtl('k', 'v', 0)).rejects.toBeInstanceOf(
      RedisKeyError,
    );
  });

  it('logs recovery once the connection is restored after an outage', async () => {
    const { client, service } = createHarness();
    await service.connect();

    client.emit('error', new Error('down'));
    expect(warnSpy).toHaveBeenCalledTimes(1);

    client.emit('ready');
    expect(logSpy).toHaveBeenCalledWith('Redis connection restored.');
    expect(service.isConnected()).toBe(true);
  });

  it('discards an ended client and creates a fresh client for the next command', async () => {
    const first = new FakeRedisClient();
    const second = new FakeRedisClient();
    const factory = jest
      .fn<RawRedisClient, []>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const service = new RedisService(
      {
        url: SECRET_URL,
        connectTimeoutMs: 3000,
        commandTimeoutMs: 1000,
      },
      factory,
    );

    await expect(service.ping()).resolves.toBe('PONG');
    first.emit('end');
    expect(service.isConnected()).toBe(false);
    await expect(service.get('after-end')).resolves.toBeNull();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(first.connect).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledTimes(1);
    expect(second.get).toHaveBeenCalledWith('after-end');
  });

  it('bounds command duration and observes a later raw rejection', async () => {
    jest.useFakeTimers();
    const client = new FakeRedisClient();
    let rejectRaw!: (error: Error) => void;
    client.get.mockReturnValue(
      new Promise<string | null>((_, reject) => {
        rejectRaw = reject;
      }),
    );
    const service = new RedisService(
      {
        url: SECRET_URL,
        connectTimeoutMs: 3000,
        commandTimeoutMs: 100,
      },
      () => client,
    );

    const result = service.get('slow');
    const expectation = expect(result).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    await jest.advanceTimersByTimeAsync(100);
    await expectation;
    rejectRaw(new Error('late rejection'));
    await Promise.resolve();
    jest.useRealTimers();
  });
});
