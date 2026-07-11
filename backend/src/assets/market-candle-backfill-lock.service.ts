import { Injectable } from '@nestjs/common';
import { RedisLockService, type RedisLock } from '../redis/redis-lock.service';

// Long-running backfill locks are separate from the short candle HTTP
// single-flight locks: different key namespace, much longer TTL, and explicit
// renewal between provider pages.
const LOCK_KEY_PREFIX = 'candles:sync:lock:v1';

export type MarketCandleBackfillLockHandle = {
  assetId: string;
  feed: string;
  lock: RedisLock;
  ttlMs: number;
  renewIntervalMs: number;
  lastRenewedAtMs: number;
};

export type MarketCandleBackfillLockAcquireResult =
  | { acquired: true; handle: MarketCandleBackfillLockHandle }
  | { acquired: false; reason: 'busy' | 'unavailable' };

/**
 * Distributed per-asset/feed lock for candle backfill.
 *
 * Exactly one owner may sync a given (assetId, feed) at a time; different
 * assets/feeds can proceed in parallel. The lock is Redis SET NX PX with a
 * fenced token, renewed between provider pages. When renewal reports lost
 * ownership the caller must stop before the next provider page. When Redis
 * itself is unavailable the lock is reported as unavailable and the sync is
 * refused — mutual exclusion across instances cannot be guaranteed without
 * it.
 */
@Injectable()
export class MarketCandleBackfillLockService {
  constructor(private readonly locks: RedisLockService) {}

  async acquire(input: {
    assetId: string;
    feed: string;
    ttlSeconds: number;
    renewSeconds: number;
    now?: Date;
  }): Promise<MarketCandleBackfillLockAcquireResult> {
    const ttlMs = input.ttlSeconds * 1_000;
    const result = await this.locks.acquire(
      buildLockKey(input.assetId, input.feed),
      ttlMs,
    );
    if (result.status === 'acquired') {
      return {
        acquired: true,
        handle: {
          assetId: input.assetId,
          feed: input.feed,
          lock: result.lock,
          ttlMs,
          renewIntervalMs: input.renewSeconds * 1_000,
          lastRenewedAtMs: (input.now ?? new Date()).getTime(),
        },
      };
    }
    return {
      acquired: false,
      reason: result.status === 'busy' ? 'busy' : 'unavailable',
    };
  }

  /**
   * Renews the lock when the renewal interval has elapsed. Returns false as
   * soon as ownership can no longer be proven; the caller must not run any
   * further provider page after that.
   */
  async renewIfDue(
    handle: MarketCandleBackfillLockHandle,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (now.getTime() - handle.lastRenewedAtMs < handle.renewIntervalMs) {
      return true;
    }
    const renewed = await this.locks.extend(handle.lock, handle.ttlMs);
    if (renewed) {
      handle.lastRenewedAtMs = now.getTime();
    }
    return renewed;
  }

  /** Releases only our own lock (compare-and-delete on the fenced token). */
  async release(handle: MarketCandleBackfillLockHandle): Promise<boolean> {
    return this.locks.release(handle.lock);
  }
}

export function buildLockKey(assetId: string, feed: string): string {
  return `${LOCK_KEY_PREFIX}:${assetId}:${feed}`;
}
