import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import type {
  AssetCandlesResponse,
  CandleInterval,
} from './asset-candles.service';
import type { CandleCacheConfig } from './asset-candles-cache.config';
import { readCandleCacheConfig } from './asset-candles-cache.config';
import {
  buildCandleDataKey,
  buildCandleGenerationKey,
  CandleCacheKeyInput,
} from './asset-candles-cache.keys';

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

export const CANDLE_CACHE_ENVELOPE_VERSION = 1;

// Versioned envelope actually stored in Redis. `value` is the exact HTTP
// response; the envelope adds only cache metadata and never alters the response.
export type CandleCacheEnvelope = {
  version: number;
  cachedAt: string;
  value: AssetCandlesResponse;
};

export type CandleCacheReadResult =
  | { status: 'hit'; value: AssetCandlesResponse; cachedAt: Date }
  | { status: 'miss' }
  | { status: 'disabled' }
  | { status: 'error' };

export type CandleCacheWriteResult =
  | { status: 'stored'; ttlSeconds: number; byteSize: number }
  | { status: 'skipped_disabled' }
  | { status: 'skipped_oversized'; byteSize: number }
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

  constructor(
    private readonly redis: RedisService,
    private readonly config: CandleCacheConfig = readCandleCacheConfig(),
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Reads the cached response for a query. Never throws: operational Redis
   * failures are reported as `error` (callers fail open to their normal load
   * path), a missing entry is `miss`, and a corrupt/unsupported entry is
   * deleted best-effort and reported as `miss`.
   */
  async get(input: CandleCacheKeyInput): Promise<CandleCacheReadResult> {
    if (!this.config.enabled) {
      return { status: 'disabled' };
    }

    try {
      const generation = await this.readGeneration(input.assetId);
      const key = buildCandleDataKey({ ...input, generation });
      const raw = await this.redis.get(key);
      if (raw === null) {
        return { status: 'miss' };
      }

      const parsed = this.parseEnvelope(raw);
      if (!parsed) {
        // Corrupt or unsupported entry: drop it best-effort, then miss.
        await this.safeDelete(key);
        return { status: 'miss' };
      }

      return {
        status: 'hit',
        value: parsed.value,
        cachedAt: parsed.cachedAt,
      };
    } catch (error) {
      this.logOperationalError('get', error);
      return { status: 'error' };
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
      const envelope: CandleCacheEnvelope = {
        version: CANDLE_CACHE_ENVELOPE_VERSION,
        cachedAt: new Date().toISOString(),
        value,
      };
      const serialized = JSON.stringify(envelope);
      const byteSize = Buffer.byteLength(serialized, 'utf8');

      if (byteSize > this.config.maxPayloadBytes) {
        // Log only the byte size, never the payload contents.
        this.logger.warn(
          `Candle cache payload skipped: ${byteSize} bytes exceeds ${this.config.maxPayloadBytes} byte limit.`,
        );
        return { status: 'skipped_oversized', byteSize };
      }

      const generation = await this.readGeneration(input.assetId);
      const key = buildCandleDataKey({ ...input, generation });
      const ttlSeconds = resolveCandleCacheTtlSeconds(input.interval);
      await this.redis.setWithTtl(key, serialized, ttlSeconds);

      return { status: 'stored', ttlSeconds, byteSize };
    } catch (error) {
      this.logOperationalError('set', error);
      return { status: 'error' };
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
      return { status: 'invalidated' };
    } catch (error) {
      this.logOperationalError('delete', error);
      return { status: 'error' };
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
      return { status: 'invalidated', generation };
    } catch (error) {
      this.logOperationalError('invalidateAsset', error);
      return { status: 'error' };
    }
  }

  // A missing generation key means generation 0. A non-integer/negative value
  // (only possible via external tampering; INCR always writes integers) is
  // treated as 0 defensively.
  private async readGeneration(assetId: string): Promise<number> {
    const raw = await this.redis.get(buildCandleGenerationKey(assetId));
    if (raw === null) {
      return 0;
    }

    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  // Returns null for any malformed, unsupported, or invalid entry so the caller
  // treats it as a corrupt cache. Reads fields directly (no object merge) to
  // avoid prototype-pollution from a hostile cached document.
  private parseEnvelope(raw: string): {
    value: AssetCandlesResponse;
    cachedAt: Date;
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
    if (envelope.version !== CANDLE_CACHE_ENVELOPE_VERSION) {
      return null;
    }

    if (typeof envelope.cachedAt !== 'string') {
      return null;
    }

    const cachedAt = new Date(envelope.cachedAt);
    if (Number.isNaN(cachedAt.getTime())) {
      return null;
    }

    if (typeof envelope.value !== 'object' || envelope.value === null) {
      return null;
    }

    return { value: envelope.value, cachedAt };
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.redis.delete(key);
    } catch (error) {
      this.logOperationalError('deleteCorrupt', error);
    }
  }

  // Logs safe metadata only (operation name + error name/code), never the key,
  // payload, URL, or any secret.
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
