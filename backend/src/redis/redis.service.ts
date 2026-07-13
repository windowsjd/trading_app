import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import { readRedisConfig } from './redis.config';
import {
  REDIS_MAX_RETRIES_PER_REQUEST,
  REDIS_RECONNECT_MAX_DELAY_MS,
  REDIS_RECONNECT_MIN_DELAY_MS,
} from './redis.constants';
import type {
  RawRedisClient,
  RawRedisClientFactory,
  RedisConfig,
} from './redis.types';
import { RedisKeyError, RedisUnavailableError } from './redis.types';

// Default factory: constructs a real ioredis client. `lazyConnect` keeps the
// process from opening a socket until the first operation, so the app boots
// cleanly with the candle cache disabled and Redis absent. The bounded
// `retryStrategy` guarantees reconnect backoff never becomes a tight loop.
const defaultRawRedisClientFactory: RawRedisClientFactory = (
  config: RedisConfig,
): RawRedisClient => {
  if (!config.url) {
    throw new RedisUnavailableError('REDIS_URL is not configured.');
  }

  return new IORedis(config.url, {
    lazyConnect: true,
    connectTimeout: config.connectTimeoutMs,
    commandTimeout: config.commandTimeoutMs,
    maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: false,
    retryStrategy: (times: number): number => {
      const backoff = REDIS_RECONNECT_MIN_DELAY_MS * 2 ** Math.min(times, 6);
      return Math.min(backoff, REDIS_RECONNECT_MAX_DELAY_MS);
    },
  }) as unknown as RawRedisClient;
};

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RawRedisClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private ready = false;
  // State-change based logging: a single connection outage logs at most one
  // warning until the connection recovers, so a downed Redis cannot flood logs.
  private outageLogged = false;

  constructor(
    private readonly config: RedisConfig = readRedisConfig(),
    private readonly clientFactory: RawRedisClientFactory = defaultRawRedisClientFactory,
  ) {}

  isConnected(): boolean {
    return this.ready;
  }

  /**
   * Establishes the connection if needed. Concurrent callers share a single
   * in-flight connect promise, so the underlying client connects only once.
   * Throws RedisUnavailableError on failure; callers that must fail open
   * (the candle cache) catch it and degrade to a miss/error status.
   */
  async connect(): Promise<void> {
    await this.ensureConnected();
  }

  async ping(): Promise<string> {
    const client = await this.ensureConnected();
    return this.runCommand(client, () => client.ping());
  }

  async get(key: string): Promise<string | null> {
    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    return this.runCommand(client, () => client.get(validKey));
  }

  /**
   * Atomic write-with-expiry (`SET key value EX ttl`). A single round trip sets
   * the value and TTL together; there is no non-atomic SET-then-EXPIRE window.
   */
  async setWithTtl(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RedisKeyError('ttlSeconds must be a positive integer.');
    }

    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    await this.runCommand(client, () =>
      client.set(validKey, value, 'EX', ttlSeconds),
    );
  }

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.requirePositiveInteger(ttlMs, 'ttlMs');
    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    const result = await this.runCommand(client, () =>
      client.set(validKey, value, 'PX', ttlMs, 'NX'),
    );
    return result === 'OK';
  }

  async eval(
    script: string,
    keys: readonly string[],
    args: readonly string[] = [],
  ): Promise<unknown> {
    if (typeof script !== 'string' || script.trim() === '') {
      throw new RedisKeyError('Redis script must be a non-empty string.');
    }
    const validatedKeys = keys.map((key) => this.requireKey(key));
    const client = await this.ensureConnected();
    return this.runCommand(client, () =>
      client.eval(script, validatedKeys.length, ...validatedKeys, ...args),
    );
  }

  async delete(key: string): Promise<number> {
    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    return this.runCommand(client, () => client.del(validKey));
  }

  async increment(key: string): Promise<number> {
    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    return this.runCommand(client, () => client.incr(validKey));
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RedisKeyError('ttlSeconds must be a positive integer.');
    }

    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    const result = await this.runCommand(client, () =>
      client.expire(validKey, ttlSeconds),
    );
    return result === 1;
  }

  async ttl(key: string): Promise<number> {
    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    return this.runCommand(client, () => client.ttl(validKey));
  }

  async publish(channel: string, message: string): Promise<number> {
    const validChannel = this.requireKey(channel);
    const client = await this.ensureConnected();
    return this.runCommand(client, () => client.publish(validChannel, message));
  }

  async zrangeByScore(
    key: string,
    min: number | string,
    max: number | string,
    limit?: number,
  ): Promise<string[]> {
    const validKey = this.requireKey(key);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new RedisKeyError('limit must be a positive integer.');
    }
    const client = await this.ensureConnected();
    return this.runCommand(client, () =>
      limit === undefined
        ? client.zrangebyscore(validKey, min, max)
        : client.zrangebyscore(validKey, min, max, 'LIMIT', 0, limit),
    );
  }

  async addToSortedSet(
    key: string,
    score: number,
    member: string,
  ): Promise<number> {
    if (!Number.isFinite(score)) {
      throw new RedisKeyError('score must be a finite number.');
    }
    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    return this.runCommand(client, () => client.zadd(validKey, score, member));
  }

  async removeFromSortedSet(
    key: string,
    members: readonly string[],
  ): Promise<number> {
    if (members.length === 0) return 0;
    const validKey = this.requireKey(key);
    const client = await this.ensureConnected();
    return this.runCommand(client, () => client.zrem(validKey, ...members));
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) {
      return;
    }

    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    this.ready = false;

    try {
      await client.quit();
    } catch {
      // Quit can fail if the socket is already gone; force-close as a fallback
      // so shutdown never hangs. No secret/URL is logged.
      try {
        client.disconnect();
      } catch {
        // Nothing more to do on shutdown.
      }
    }
  }

  private ensureConnected(): Promise<RawRedisClient> {
    const client = this.getOrCreateClient();
    if (this.ready) {
      return Promise.resolve(client);
    }

    if (!this.connectPromise) {
      this.connectPromise = this.openConnection(client);
    }

    return this.connectPromise.then(() => client);
  }

  private async openConnection(client: RawRedisClient): Promise<void> {
    try {
      await client.connect();
      if (this.client !== client) {
        throw new RedisUnavailableError(
          'Redis connection ended while opening.',
        );
      }
      this.markReady();
    } catch (error) {
      // Allow a later operation to retry a fresh connect instead of caching a
      // permanently rejected promise.
      this.connectPromise = null;
      this.handleConnectionError(error);
      throw new RedisUnavailableError('Redis connection failed.');
    }
  }

  private getOrCreateClient(): RawRedisClient {
    if (this.client) {
      return this.client;
    }

    let client: RawRedisClient;
    try {
      client = this.clientFactory(this.config);
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        this.handleConnectionError(error);
      }
      throw error;
    }
    this.registerListeners(client);
    this.client = client;
    return client;
  }

  private registerListeners(client: RawRedisClient): void {
    // A missing 'error' listener would let ioredis emit an unhandled 'error'
    // event and crash the process; this handler keeps failures fail-open.
    client.on('error', (error: unknown) => {
      this.handleConnectionError(error);
    });
    client.on('ready', () => {
      if (this.client === client) {
        this.markReady();
      }
    });
    client.on('end', () => {
      if (this.client !== client) {
        return;
      }
      // An ended ioredis instance cannot be connected again. Drop every
      // reference so the next operation constructs a fresh client.
      this.ready = false;
      this.connectPromise = null;
      this.client = null;
    });
  }

  private markReady(): void {
    this.ready = true;
    this.connectPromise = Promise.resolve();
    if (this.outageLogged) {
      this.logger.log('Redis connection restored.');
      this.outageLogged = false;
    }
  }

  private handleConnectionError(error: unknown): void {
    this.ready = false;
    if (this.outageLogged) {
      return;
    }

    this.outageLogged = true;
    // Log only a safe error name/code — never the URL, password, or payload.
    this.logger.warn(
      `Redis unavailable; dependent operations will degrade safely (${this.describeError(
        error,
      )}).`,
    );
  }

  private describeError(error: unknown): string {
    if (error && typeof error === 'object') {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) {
        return code;
      }

      const name = (error as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) {
        return name;
      }
    }

    return 'connection error';
  }

  private requireKey(key: string): string {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new RedisKeyError('Redis key must be a non-empty string.');
    }

    return key;
  }

  private requirePositiveInteger(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RedisKeyError(`${field} must be a positive integer.`);
    }
  }

  private async runCommand<T>(
    client: RawRedisClient,
    command: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const operation = Promise.resolve().then(command);
    // Attach a rejection handler through race immediately. If the timeout wins,
    // a later raw command rejection is still observed by Promise.race and can
    // never become an unhandled rejection.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RedisUnavailableError('Redis command timed out.')),
        this.config.commandTimeoutMs,
      );
    });

    try {
      const result = await Promise.race([operation, timeout]);
      if (this.client === client) {
        this.markReady();
      }
      return result;
    } catch (error) {
      if (error instanceof RedisKeyError) {
        throw error;
      }
      this.handleConnectionError(error);
      if (error instanceof RedisUnavailableError) {
        throw error;
      }
      throw new RedisUnavailableError('Redis command failed.');
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
