// Narrow structural interface for the raw Redis client commands RedisService
// uses. ioredis's `Redis` satisfies this, and unit tests provide a lightweight
// fake without pulling in a real connection. Keeping this surface small also
// documents exactly which raw commands the wrapper depends on today; the
// upcoming distributed lock and rate limiter (step 1-3) can extend it with
// SET NX / eval as needed.
export interface RawRedisClient {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
  ): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  disconnect(): void;
  readonly status: string;
}

export type RedisConfig = {
  // undefined when REDIS_URL is not configured; connection attempts then fail
  // open (operations report errors) instead of crashing the process.
  url: string | undefined;
  connectTimeoutMs: number;
};

export type RawRedisClientFactory = (config: RedisConfig) => RawRedisClient;

// Thrown for operational connection problems (no URL, connect timeout, refused
// connection). Callers such as the candle cache treat this as fail-open.
export class RedisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

// Thrown for programmer errors (e.g. empty key). These are NOT swallowed as
// cache misses; they indicate a bug in the caller.
export class RedisKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisKeyError';
  }
}
