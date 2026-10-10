import { randomUUID } from 'node:crypto';
import { RedisService } from '../../redis/redis.service';
import { ProviderHttpError } from '../provider.types';

const STATE = 'provider:{binance-rest}:state';
const LEASES = 'provider:{binance-rest}:leases';
const MAX_WAIT_MS = 7 * 86_400_000;
const STATE_TTL_MS = MAX_WAIT_MS + 86_400_000;
export const BINANCE_REST_MAX_CONCURRENCY = 2;

// All time and admission decisions are atomic and use the Redis server clock.
const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local untilAt = tonumber(redis.call('HGET', KEYS[1], 'until') or '0')
if untilAt > now then return {0, untilAt - now, tonumber(redis.call('HGET', KEYS[1], 'status') or '0')} end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local recovery = redis.call('HGET', KEYS[1], 'recovery') == '1'
local active = redis.call('ZCARD', KEYS[2])
if recovery and active > 0 then return {0, 1000, 0} end
if active >= ${BINANCE_REST_MAX_CONCURRENCY} then return {0, 50, 0, 1} end
local minute = math.floor(now / 60000)
if tonumber(redis.call('HGET', KEYS[1], 'minute') or '-1') ~= minute then
  redis.call('HSET', KEYS[1], 'minute', minute, 'weight', 0)
end
local weight = tonumber(redis.call('HGET', KEYS[1], 'weight') or '0')
if weight + tonumber(ARGV[2]) > tonumber(ARGV[4]) then return {0, (minute + 1) * 60000 - now, 0} end
redis.call('HINCRBY', KEYS[1], 'weight', ARGV[2])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), ARGV[1])
if recovery then redis.call('HSET', KEYS[1], 'probe', ARGV[1]) end
redis.call('PEXPIRE', KEYS[1], ARGV[5])
redis.call('PEXPIRE', KEYS[2], 3600000)
return {1, 0, 0}
`;

const COMPLETE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREM', KEYS[2], ARGV[1])
local untilAt = tonumber(redis.call('HGET', KEYS[1], 'until') or '0')
local probe = redis.call('HGET', KEYS[1], 'probe') == ARGV[1]
if ARGV[2] == 'limited' then
  local nextAt = now + tonumber(ARGV[3])
  if nextAt > untilAt then redis.call('HSET', KEYS[1], 'until', nextAt, 'status', ARGV[4]) end
  redis.call('HSET', KEYS[1], 'recovery', 1)
  redis.call('HDEL', KEYS[1], 'probe')
elseif probe and untilAt <= now then
  if ARGV[2] == 'success' then
    redis.call('HDEL', KEYS[1], 'recovery', 'probe', 'until', 'status')
  else
    redis.call('HSET', KEYS[1], 'until', now + 30000, 'recovery', 1, 'status', 0)
    redis.call('HDEL', KEYS[1], 'probe')
  end
end
local minute = math.floor(now / 60000)
if ARGV[5] ~= '' and tonumber(redis.call('HGET', KEYS[1], 'minute') or '-1') == minute then
  local weight = tonumber(redis.call('HGET', KEYS[1], 'weight') or '0')
  redis.call('HSET', KEYS[1], 'weight', math.max(weight, tonumber(ARGV[5])))
end
redis.call('PEXPIRE', KEYS[1], ARGV[6])
return 1
`;

export class BinanceRestCoordinator {
  private readonly budget: number;
  private pendingRestriction: { deadline: number; status: number } | undefined;

  constructor(private readonly redis: RedisService) {
    const raw = process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE ?? '600';
    const budget = Number(raw);
    if (
      !/^\d+$/u.test(raw) ||
      !Number.isInteger(budget) ||
      budget < 20 ||
      budget > 600
    ) {
      // @diagnosticSurface internal: Invalid local budget is caught by ingestion/Ops boundaries; the message contains only the public configuration key and range.
      throw new Error('BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE must be 20..600.');
    }
    this.budget = budget;
  }

  async acquire(url: string, timeoutMs: number): Promise<string> {
    const token = randomUUID();
    const deadline = performance.now() + Math.min(1000, timeoutMs / 2);
    for (let attempt = 0; ; attempt++) {
      if (this.pendingRestriction) {
        const remaining = Math.max(
          0,
          this.pendingRestriction.deadline - performance.now(),
        );
        await this.complete(
          'unpersisted-restriction',
          'limited',
          remaining,
          this.pendingRestriction.status,
        );
      }
      let result: unknown;
      try {
        result = await this.redis.eval(
          ACQUIRE,
          [STATE, LEASES],
          [
            token,
            String(requestWeight(url)),
            String(timeoutMs + 5000),
            String(this.budget),
            String(STATE_TTL_MS),
          ],
        );
      } catch {
        throw unavailable();
      }
      if (!Array.isArray(result) || ![3, 4].includes(result.length))
        throw unavailable();
      const [allowed, wait, status] = result as number[];
      if (![allowed, wait, status].every(Number.isFinite)) throw unavailable();
      if (allowed !== 1) {
        const busy = result[3] === 1;
        const remaining = deadline - performance.now();
        if (busy && remaining > 0 && attempt < 20) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(50, remaining)),
          );
          continue;
        }
        // @diagnosticSurface internal: HTTP/Ops boundaries receive a fixed admission category and numeric timing only, without Redis or provider details.
        throw new ProviderHttpError(
          'binance',
          busy ? 'BINANCE_REST_BUSY' : 'PROVIDER_RATE_LIMITED',
          busy
            ? 'binance REST slots busy (BINANCE_REST_BUSY).'
            : 'binance REST admission paused (PROVIDER_RATE_LIMITED).',
          { status, retryAfterMs: wait },
        );
      }
      return token;
    }
  }

  async complete(
    token: string,
    outcome: 'success' | 'failure' | 'limited',
    retryAfterMs = 0,
    status = 0,
    usedWeight1m?: number,
  ): Promise<void> {
    if (outcome === 'limited') {
      const deadline = performance.now() + retryAfterMs;
      if (
        !this.pendingRestriction ||
        deadline >= this.pendingRestriction.deadline
      )
        this.pendingRestriction = { deadline, status };
    }
    const pendingRestriction = this.pendingRestriction;
    // A shorter completion may carry a longer restriction left by a failed write.
    // Clear only the snapshot actually published; newer restrictions stay pending.
    if (outcome === 'limited' && pendingRestriction) {
      retryAfterMs = Math.max(
        0,
        pendingRestriction.deadline - performance.now(),
      );
      status = pendingRestriction.status;
    }
    try {
      await this.redis.eval(
        COMPLETE,
        [STATE, LEASES],
        [
          token,
          outcome,
          String(retryAfterMs),
          String(status),
          usedWeight1m === undefined ? '' : String(usedWeight1m),
          String(STATE_TTL_MS),
        ],
      );
      if (
        outcome === 'limited' &&
        this.pendingRestriction === pendingRestriction
      )
        this.pendingRestriction = undefined;
    } catch {
      // An unrecorded restriction must not reopen REST admission on this process.
      throw unavailable();
    }
  }
}

function unavailable() {
  // @diagnosticSurface internal: The HTTP client and Ops boundaries receive a fixed safe category; the original Redis exception is discarded.
  return new ProviderHttpError(
    'binance',
    'BINANCE_REST_COORDINATION_UNAVAILABLE',
    'binance REST coordination unavailable (BINANCE_REST_COORDINATION_UNAVAILABLE).',
  );
}

function requestWeight(url: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 80;
  }
  if (parsed.pathname === '/api/v3/klines') return 2;
  if (parsed.pathname === '/api/v3/exchangeInfo') return 20;
  if (parsed.pathname === '/fapi/v1/exchangeInfo') return 1;
  if (parsed.pathname === '/fapi/v1/premiumIndex')
    return parsed.searchParams.has('symbol') ? 1 : 10;
  if (parsed.pathname === '/fapi/v2/ticker/price')
    return parsed.searchParams.has('symbol') ? 1 : 2;
  if (
    parsed.pathname === '/api/v3/ticker/24hr' &&
    parsed.searchParams.has('symbol')
  )
    return 2;
  return 80;
}

export function parseBinanceRetryAfter(
  headers: Headers | undefined,
  status: number,
  receivedAt: Date,
): number {
  const fallback = status === 418 ? 120_000 : 60_000;
  const value = headers?.get('retry-after')?.trim();
  if (!value) return fallback;
  if (/^\d+$/u.test(value))
    return Math.max(1000, Math.min(MAX_WAIT_MS, Number(value) * 1000));
  const date = httpDate(value);
  const serverDate = httpDate(headers?.get('date') ?? '');
  const wait =
    date - (Number.isFinite(serverDate) ? serverDate : receivedAt.getTime());
  return Number.isFinite(wait) && wait > 0
    ? Math.max(1000, Math.min(MAX_WAIT_MS, wait))
    : fallback;
}

function httpDate(value: string): number {
  const parsed = Date.parse(value);
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
    value,
  ) &&
    Number.isFinite(parsed) &&
    new Date(parsed).toUTCString() === value
    ? parsed
    : NaN;
}

export function binanceUsedWeight(
  headers: Headers | undefined,
): number | undefined {
  const raw = headers?.get('x-mbx-used-weight-1m');
  const value = raw && /^\d+$/u.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}
