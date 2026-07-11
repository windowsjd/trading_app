// Redis connection defaults. These are connection-layer concerns only; candle
// cache behavior (enabled flag, payload size, TTLs) lives with the cache
// service, not here.
export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 3000;
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1000;

// Bounded reconnect backoff so a downed Redis never produces a tight, infinite
// fast-retry loop. Delay grows exponentially from MIN up to a hard MAX cap and
// then stays capped; the client keeps retrying in the background (a cache is an
// optimization layer, so we prefer eventual reconnection over giving up).
export const REDIS_RECONNECT_MIN_DELAY_MS = 200;
export const REDIS_RECONNECT_MAX_DELAY_MS = 5000;

// Commands fail fast instead of queueing forever when Redis is unavailable, so
// cache reads/writes surface an error quickly and callers can fail open.
export const REDIS_MAX_RETRIES_PER_REQUEST = 1;
