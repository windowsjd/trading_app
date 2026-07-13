import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import type {
  AssetCandlesResponse,
  CandleInterval,
} from './asset-candles.service';
import type { CandleCacheConfig } from './asset-candles-cache.config';
import {
  CandleCacheConfigError,
  readCandleCacheConfig,
} from './asset-candles-cache.config';
import {
  buildCandleDataKey,
  buildCandleGenerationKey,
  CandleCacheKeyInput,
  CandleCacheKeyError,
} from './asset-candles-cache.keys';
import { RedisConfigError } from '../redis/redis.config';
import { RedisKeyError, RedisUnavailableError } from '../redis/redis.types';
import { REDIS_SET_CANDLE_IF_OWNER_AND_GENERATION_SCRIPT } from '../redis/redis-lua-scripts';

// Central TTL policy keyed by the API-supported CandleInterval set (the
// `Record<CandleInterval, number>` type makes coverage exhaustive at compile
// time). Shorter intervals expire faster because their latest candle changes
// more often. TTLs are code constants, not env, to keep the policy in one place.
export const CANDLE_CACHE_TTL_SECONDS: Record<CandleInterval, number> = {
  '1m': 15,
  '5m': 30,
  '15m': 60,
  '30m': 60,
  '1h': 120,
  '4h': 300,
  '1d': 900,
  '1w': 3600,
};

// Fallback for an interval outside the known set (defensive; inputs are typed
// CandleInterval). Uses the shortest TTL so an unexpected value never over-caches.
const FALLBACK_CANDLE_CACHE_TTL_SECONDS = 15;

export function resolveCandleCacheTtlSeconds(interval: CandleInterval): number {
  return (
    CANDLE_CACHE_TTL_SECONDS[interval] ?? FALLBACK_CANDLE_CACHE_TTL_SECONDS
  );
}

export const CANDLE_CACHE_ENVELOPE_VERSION = 2;

// Versioned envelope actually stored in Redis. `value` is the exact HTTP
// response; the envelope adds only cache metadata and never alters the response.
export type CandleCacheEnvelope = {
  schemaVersion: number;
  cachedAt: string;
  freshUntil: string;
  staleUntil: string;
  response: AssetCandlesResponse;
};

export type CandleCacheReadResult =
  | { status: 'fresh'; value: AssetCandlesResponse; cachedAt: Date }
  | { status: 'stale'; value: AssetCandlesResponse; cachedAt: Date }
  | { status: 'miss' }
  | { status: 'corrupt' }
  | { status: 'disabled' }
  | { status: 'error' };

export type CandleCacheWriteResult =
  | { status: 'stored'; ttlSeconds: number; byteSize: number }
  | { status: 'skipped_disabled' }
  | { status: 'skipped_oversized'; byteSize: number }
  | { status: 'error' };

export type CandleCacheConditionalWriteResult =
  | { status: 'stored'; ttlSeconds: number; byteSize: number }
  | { status: 'skipped_generation_changed' }
  | { status: 'skipped_lock_lost' }
  | { status: 'skipped_disabled' }
  | { status: 'skipped_oversized'; byteSize: number }
  | { status: 'error' };

export type CandleCacheContext = {
  input: CandleCacheKeyInput;
  generation: number;
  generationKey: string;
  dataKey: string;
};

export type CandleCacheContextResult =
  | { status: 'resolved'; context: CandleCacheContext }
  | { status: 'disabled' }
  | { status: 'error' };

export type CandleCacheDeleteResult =
  | { status: 'invalidated' }
  | { status: 'disabled' }
  | { status: 'error' };

export type CandleCacheInvalidateResult =
  | { status: 'invalidated'; generation: number }
  | { status: 'disabled' }
  | { status: 'error' };

@Injectable()
export class AssetCandlesCacheService {
  private readonly logger = new Logger(AssetCandlesCacheService.name);
  private lastUnexpectedWarningAt: number | null = null;
  private unexpectedOutageLogged = false;

  constructor(
    private readonly redis: RedisService,
    private readonly config: CandleCacheConfig = readCandleCacheConfig(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Reads the cached response for a query. Operational Redis
   * failures are reported as `error` (callers fail open to their normal load
   * path), a missing entry is `miss`, and a corrupt/unsupported entry is
   * deleted best-effort and reported as `miss`.
   */
  async get(input: CandleCacheKeyInput): Promise<CandleCacheReadResult> {
    const resolved = await this.resolveContext(input);
    if (resolved.status !== 'resolved') return resolved;
    return this.getWithContext(resolved.context);
  }

  async resolveContext(
    input: CandleCacheKeyInput,
  ): Promise<CandleCacheContextResult> {
    if (!this.config.enabled) return { status: 'disabled' };
    try {
      const generationKey = buildCandleGenerationKey(input.assetId);
      const generation = await this.readGenerationByKey(generationKey);
      return {
        status: 'resolved',
        context: {
          input: { ...input },
          generation,
          generationKey,
          dataKey: buildCandleDataKey({ ...input, generation }),
        },
      };
    } catch (error) {
      return this.failOpenOrThrow('resolveContext', error);
    }
  }

  async getWithContext(
    context: CandleCacheContext,
  ): Promise<CandleCacheReadResult> {
    if (!this.config.enabled) return { status: 'disabled' };
    try {
      const raw = await this.redis.get(context.dataKey);
      if (raw === null) {
        this.markOperationalSuccess();
        return { status: 'miss' };
      }

      const parsed = this.parseEnvelope(raw);
      if (!parsed) {
        // Corrupt or unsupported entry: drop it best-effort, then miss.
        await this.safeDelete(context.dataKey);
        return { status: 'corrupt' };
      }

      const nowMs = this.now().getTime();
      if (nowMs >= parsed.staleUntil.getTime()) {
        await this.safeDelete(context.dataKey);
        return { status: 'miss' };
      }

      this.markOperationalSuccess();
      return {
        status: nowMs < parsed.freshUntil.getTime() ? 'fresh' : 'stale',
        value: parsed.response,
        cachedAt: parsed.cachedAt,
      };
    } catch (error) {
      return this.failOpenOrThrow('get', error);
    }
  }

  async setIfOwnerAndGeneration(
    context: CandleCacheContext,
    value: AssetCandlesResponse,
    owner: { lockKey: string; lockToken: string },
  ): Promise<CandleCacheConditionalWriteResult> {
    if (!this.config.enabled) return { status: 'skipped_disabled' };
    try {
      const serialized = this.serializeEnvelope(context.input, value);
      if (serialized.byteSize > this.config.maxPayloadBytes) {
        return { status: 'skipped_oversized', byteSize: serialized.byteSize };
      }
      const ttlSeconds = serialized.ttlSeconds;
      const result = Number(
        await this.redis.eval(
          REDIS_SET_CANDLE_IF_OWNER_AND_GENERATION_SCRIPT,
          [owner.lockKey, context.generationKey, context.dataKey],
          [
            owner.lockToken,
            String(context.generation),
            serialized.value,
            String(ttlSeconds),
          ],
        ),
      );
      if (result === -1) return { status: 'skipped_lock_lost' };
      if (result === -2) return { status: 'skipped_generation_changed' };
      if (result !== 1)
        throw new RedisUnavailableError(
          'Invalid conditional cache write result.',
        );
      this.markOperationalSuccess();
      return { status: 'stored', ttlSeconds, byteSize: serialized.byteSize };
    } catch (error) {
      return this.failOpenOrThrow('setIfOwnerAndGeneration', error);
    }
  }

  /**
   * Stores a response under an interval-based TTL using an atomic SET EX write.
   * Oversized payloads are skipped (not stored) without failing the caller.
   * Only successful available/empty responses should be passed in; provider
   * errors and auth/validation failures must not be cached by the caller.
   */
  async set(
    input: CandleCacheKeyInput,
    value: AssetCandlesResponse,
  ): Promise<CandleCacheWriteResult> {
    if (!this.config.enabled) {
      return { status: 'skipped_disabled' };
    }

    try {
      const serialized = this.serializeEnvelope(input, value);
      const byteSize = serialized.byteSize;

      if (byteSize > this.config.maxPayloadBytes) {
        // Log only the byte size, never the payload contents.
        this.logger.warn(
          `Candle cache payload skipped: ${byteSize} bytes exceeds ${this.config.maxPayloadBytes} byte limit.`,
        );
        return { status: 'skipped_oversized', byteSize };
      }

      const generation = await this.readGeneration(input.assetId);
      const key = buildCandleDataKey({ ...input, generation });
      const ttlSeconds = serialized.ttlSeconds;
      await this.redis.setWithTtl(key, serialized.value, ttlSeconds);
      this.markOperationalSuccess();
      return { status: 'stored', ttlSeconds, byteSize };
    } catch (error) {
      return this.failOpenOrThrow('set', error);
    }
  }

  /**
   * Deletes exactly the entry for this query at the current asset generation.
   * Does not scan or touch other queries/generations.
   */
  async delete(input: CandleCacheKeyInput): Promise<CandleCacheDeleteResult> {
    if (!this.config.enabled) {
      return { status: 'disabled' };
    }

    try {
      const generation = await this.readGeneration(input.assetId);
      const key = buildCandleDataKey({ ...input, generation });
      await this.redis.delete(key);
      this.markOperationalSuccess();
      return { status: 'invalidated' };
    } catch (error) {
      return this.failOpenOrThrow('delete', error);
    }
  }

  /**
   * Invalidates every cached query for one asset in O(1) by incrementing the
   * asset's generation counter. Existing entries under the previous generation
   * become unreachable and expire by TTL — no KEYS/SCAN and no FLUSH.
   */
  async invalidateAsset(assetId: string): Promise<CandleCacheInvalidateResult> {
    if (!this.config.enabled) {
      return { status: 'disabled' };
    }

    try {
      const generation = await this.redis.increment(
        buildCandleGenerationKey(assetId),
      );
      this.markOperationalSuccess();
      return { status: 'invalidated', generation };
    } catch (error) {
      return this.failOpenOrThrow('invalidateAsset', error);
    }
  }

  // A missing generation key means generation 0. A non-integer/negative value
  // (only possible via external tampering; INCR always writes integers) is
  // treated as 0 defensively.
  private async readGeneration(assetId: string): Promise<number> {
    return this.readGenerationByKey(buildCandleGenerationKey(assetId));
  }

  private async readGenerationByKey(generationKey: string): Promise<number> {
    const raw = await this.redis.get(generationKey);
    if (raw === null) {
      return 0;
    }

    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private serializeEnvelope(
    input: CandleCacheKeyInput,
    value: AssetCandlesResponse,
  ): {
    value: string;
    byteSize: number;
    ttlSeconds: number;
  } {
    const now = this.now();
    const policy = this.resolveTtlPolicy(input, value);
    const freshUntil = new Date(now.getTime() + policy.freshSeconds * 1000);
    const staleUntil = new Date(now.getTime() + policy.staleSeconds * 1000);
    const serialized = JSON.stringify({
      schemaVersion: CANDLE_CACHE_ENVELOPE_VERSION,
      cachedAt: now.toISOString(),
      freshUntil: freshUntil.toISOString(),
      staleUntil: staleUntil.toISOString(),
      response: value,
    } satisfies CandleCacheEnvelope);
    return {
      value: serialized,
      byteSize: Buffer.byteLength(serialized, 'utf8'),
      ttlSeconds: policy.staleSeconds,
    };
  }

  // Returns null for any malformed, unsupported, or invalid entry so the caller
  // treats it as a corrupt cache. Reads fields directly (no object merge) to
  // avoid prototype-pollution from a hostile cached document.
  private parseEnvelope(raw: string): {
    response: AssetCandlesResponse;
    cachedAt: Date;
    freshUntil: Date;
    staleUntil: Date;
  } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const envelope = parsed as Partial<CandleCacheEnvelope>;
    if (envelope.schemaVersion !== CANDLE_CACHE_ENVELOPE_VERSION) {
      return null;
    }

    if (
      typeof envelope.cachedAt !== 'string' ||
      typeof envelope.freshUntil !== 'string' ||
      typeof envelope.staleUntil !== 'string'
    ) {
      return null;
    }

    const cachedAt = new Date(envelope.cachedAt);
    const freshUntil = new Date(envelope.freshUntil);
    const staleUntil = new Date(envelope.staleUntil);
    if (
      Number.isNaN(cachedAt.getTime()) ||
      Number.isNaN(freshUntil.getTime()) ||
      Number.isNaN(staleUntil.getTime()) ||
      cachedAt.getTime() > freshUntil.getTime() ||
      freshUntil.getTime() > staleUntil.getTime()
    ) {
      return null;
    }

    if (!isAssetCandlesResponse(envelope.response)) {
      return null;
    }

    return { response: envelope.response, cachedAt, freshUntil, staleUntil };
  }

  private resolveTtlPolicy(
    input: CandleCacheKeyInput,
    value: AssetCandlesResponse,
  ): { freshSeconds: number; staleSeconds: number } {
    const intervalFresh = resolveCandleCacheTtlSeconds(input.interval);
    let freshSeconds = input.latest
      ? intervalFresh
      : Math.max(intervalFresh, this.config.historicalFreshTtlSeconds ?? 900);
    let staleSeconds = input.latest
      ? Math.max(freshSeconds, this.config.currentStaleTtlSeconds ?? 300)
      : Math.max(freshSeconds, this.config.historicalStaleTtlSeconds ?? 3600);
    if (value.data.state === 'empty') {
      freshSeconds = Math.min(
        freshSeconds,
        this.config.emptyFreshTtlSeconds ?? 10,
      );
      staleSeconds = Math.max(
        freshSeconds,
        Math.min(staleSeconds, this.config.emptyStaleTtlSeconds ?? 60),
      );
    }
    return { freshSeconds, staleSeconds };
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.redis.delete(key);
    } catch (error) {
      this.failOpenOrThrow('deleteCorrupt', error);
    }
  }

  // Logs safe metadata only (operation name + error name/code), never the key,
  // payload, URL, or any secret.
  private failOpenOrThrow<T extends { status: 'error' }>(
    operation: string,
    error: unknown,
  ): T {
    if (isCandleCacheProgrammerError(error)) {
      throw error;
    }

    // RedisService owns outage/recovery logging. Re-logging its operational
    // error here on every request would flood logs during an outage.
    if (error instanceof RedisUnavailableError) {
      return { status: 'error' } as T;
    }

    const now = Date.now();
    if (
      this.lastUnexpectedWarningAt === null ||
      now - this.lastUnexpectedWarningAt >= 30_000
    ) {
      this.lastUnexpectedWarningAt = now;
      this.unexpectedOutageLogged = true;
      this.logOperationalError(operation, error);
    }
    return { status: 'error' } as T;
  }

  private markOperationalSuccess(): void {
    if (!this.unexpectedOutageLogged) {
      return;
    }
    this.unexpectedOutageLogged = false;
    this.logger.log('Candle cache operation restored.');
  }

  private logOperationalError(operation: string, error: unknown): void {
    this.logger.warn(
      `Candle cache ${operation} failed; failing open (${this.describeError(
        error,
      )}).`,
    );
  }

  private describeError(error: unknown): string {
    if (error && typeof error === 'object') {
      const name = (error as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) {
        return name;
      }
    }

    return 'operational error';
  }
}

function isCandleCacheProgrammerError(error: unknown): boolean {
  return (
    error instanceof CandleCacheKeyError ||
    error instanceof RedisKeyError ||
    error instanceof CandleCacheConfigError ||
    error instanceof RedisConfigError ||
    error instanceof TypeError ||
    error instanceof RangeError
  );
}

const CANDLE_RANGES = new Set([
  '1d',
  '7d',
  '30d',
  'prev_open',
  'prev2_open',
  '1y',
  'season',
]);
const CANDLE_INTERVALS = new Set([
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
  '1w',
]);
const ASSET_TYPES = new Set(['domestic_stock', 'us_stock', 'crypto']);
const CURRENCIES = new Set(['KRW', 'USD']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

export function isAssetCandlesResponse(
  value: unknown,
): value is AssetCandlesResponse {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    return false;
  }
  const data = value.data;
  if (
    (data.state !== 'available' && data.state !== 'empty') ||
    !isRecord(data.asset) ||
    !hasStrings(data.asset, ['id', 'symbol', 'name', 'market']) ||
    !ASSET_TYPES.has(String(data.asset.assetType)) ||
    !CURRENCIES.has(String(data.asset.priceCurrency)) ||
    !CANDLE_RANGES.has(String(data.range)) ||
    !CANDLE_INTERVALS.has(String(data.interval)) ||
    typeof data.requestedDate !== 'string' ||
    !Array.isArray(data.candles) ||
    !isRecord(data.source)
  ) {
    return false;
  }
  if (
    !data.candles.every(
      (candle) =>
        isRecord(candle) &&
        hasStrings(candle, [
          'time',
          'open',
          'high',
          'low',
          'close',
          'volume',
          'amount',
          'sourceDate',
          'sourceTime',
        ]),
    )
  ) {
    return false;
  }

  const source = data.source;
  if (source.provider === 'kis') {
    return (
      hasStrings(source, ['trId', 'path', 'marketCode']) &&
      Number.isSafeInteger(source.requestedCount) &&
      Number.isSafeInteger(source.returnedCount)
    );
  }
  if (source.provider === 'binance') {
    return (
      hasStrings(source, ['endpoint', 'symbol', 'interval']) &&
      CANDLE_INTERVALS.has(String(source.interval)) &&
      Number.isSafeInteger(source.requestedCount) &&
      Number.isSafeInteger(source.returnedCount) &&
      (source.truncated === undefined || typeof source.truncated === 'boolean')
    );
  }
  return false;
}
