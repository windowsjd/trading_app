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
    return client.ping();
  }

  async get(key: string): Promise<string | null> {
    const client = await this.ensureConnected();
    return client.get(this.requireKey(key));
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

    const client = await this.ensureConnected();
    await client.set(this.requireKey(key), value, 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<number> {
    const client = await this.ensureConnected();
    return client.del(this.requireKey(key));
  }

  async increment(key: string): Promise<number> {
    const client = await this.ensureConnected();
    return client.incr(this.requireKey(key));
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RedisKeyError('ttlSeconds must be a positive integer.');
    }

    const client = await this.ensureConnected();
    const result = await client.expire(this.requireKey(key), ttlSeconds);
    return result === 1;
  }

  async ttl(key: string): Promise<number> {
    const client = await this.ensureConnected();
    return client.ttl(this.requireKey(key));
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

    const client = this.clientFactory(this.config);
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
      this.markReady();
    });
    client.on('end', () => {
      this.ready = false;
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
      `Redis unavailable; cache operations will fail open (${this.describeError(
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
}
