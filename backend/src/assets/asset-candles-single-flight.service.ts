import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisLockService, type RedisLock } from '../redis/redis-lock.service';
import type { AssetCandlesResponse } from './asset-candles.service';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import type { CandleCacheKeyInput } from './asset-candles-cache.keys';
import type { CandleCacheContext } from './asset-candles-cache.service';
import {
  readCandleSingleFlightConfig,
  type CandleSingleFlightConfig,
} from './asset-candles-single-flight.config';

export class CandleSingleFlightWaitTimeoutError extends Error {
  constructor() {
    super('Candle single-flight wait timeout exceeded.');
    this.name = 'CandleSingleFlightWaitTimeoutError';
  }
}

export type CandleSingleFlightInput = {
  cacheKeyInput: CandleCacheKeyInput;
  loader: () => Promise<AssetCandlesResponse>;
};

@Injectable()
export class AssetCandlesSingleFlightService {
  private readonly logger = new Logger(AssetCandlesSingleFlightService.name);
  private readonly inFlight = new Map<string, Promise<AssetCandlesResponse>>();

  constructor(
    private readonly cache: AssetCandlesCacheService,
    private readonly locks: RedisLockService,
    private readonly config: CandleSingleFlightConfig = readCandleSingleFlightConfig(),
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async getOrLoad(
    input: CandleSingleFlightInput,
  ): Promise<AssetCandlesResponse> {
    const resolved = await this.cache.resolveContext(input.cacheKeyInput);
    const identity =
      resolved.status === 'resolved'
        ? resolved.context.dataKey
        : `candles:local:${createHash('sha256')
            .update(JSON.stringify(input.cacheKeyInput))
            .digest('hex')}`;
    const initial =
      resolved.status === 'resolved'
        ? await this.cache.getWithContext(resolved.context)
        : resolved;
    if (initial.status === 'hit') return initial.value;

    const existing = this.inFlight.get(identity);
    if (existing) return existing;

    const promise = this.coordinate(
      identity,
      resolved.status === 'resolved' ? resolved.context : null,
      input,
    );
    this.inFlight.set(identity, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(identity) === promise)
        this.inFlight.delete(identity);
    }
  }

  getInFlightCount(): number {
    return this.inFlight.size;
  }

  private async coordinate(
    identity: string,
    context: CandleCacheContext | null,
    input: CandleSingleFlightInput,
  ): Promise<AssetCandlesResponse> {
    if (!context || !this.cache.isEnabled()) return input.loader();

    const key = `candles:lock:v1:${createHash('sha256')
      .update(identity)
      .digest('hex')}`;
    const acquired = await this.locks.acquire(key, this.config.lockTtlMs);
    if (acquired.status === 'error') return input.loader();
    if (acquired.status === 'acquired') {
      return this.loadAsOwner(acquired.lock, context, input);
    }
    return this.waitForOwner(key, context, input);
  }

  private async loadAsOwner(
    lock: RedisLock,
    context: CandleCacheContext,
    input: CandleSingleFlightInput,
  ): Promise<AssetCandlesResponse> {
    let ownershipLost = false;
    let finished = false;
    let renewing = false;
    let renewalPromise: Promise<void> | null = null;
    const renewal = setInterval(() => {
      if (finished || renewing) return;
      renewing = true;
      renewalPromise = this.locks
        .extend(lock, this.config.lockTtlMs)
        .then((extended) => {
          if (!finished && !extended)
            this.markOwnershipLost(() => (ownershipLost = true), ownershipLost);
        })
        .catch(() => {
          if (!finished)
            this.markOwnershipLost(() => (ownershipLost = true), ownershipLost);
        })
        .finally(() => {
          renewing = false;
        });
    }, this.config.renewIntervalMs);

    try {
      const doubleCheck = await this.cache.getWithContext(context);
      if (doubleCheck.status === 'hit') return doubleCheck.value;
      const value = await input.loader();
      // A renewal may still be in flight when the loader completes. Its result
      // must be known before a distributed write is attempted.
      if (renewalPromise) await renewalPromise;
      // Operational cache failures are returned as status:error and do not
      // turn a successful provider load into a user-visible failure.
      if (!ownershipLost) {
        await this.cache.setIfOwnerAndGeneration(context, value, {
          lockKey: lock.key,
          lockToken: lock.token,
        });
      }
      return value;
    } finally {
      finished = true;
      clearInterval(renewal);
      if (renewalPromise) await renewalPromise;
      await this.locks.release(lock);
    }
  }

  private async waitForOwner(
    key: string,
    context: CandleCacheContext,
    input: CandleSingleFlightInput,
  ): Promise<AssetCandlesResponse> {
    const deadline = this.now() + this.config.waitTimeoutMs;
    while (this.now() < deadline) {
      const cached = await this.cache.getWithContext(context);
      if (cached.status === 'hit') return cached.value;
      if (cached.status === 'error' || cached.status === 'disabled') {
        return input.loader();
      }
      const takeover = await this.locks.acquire(key, this.config.lockTtlMs);
      if (takeover.status === 'acquired') {
        return this.loadAsOwner(takeover.lock, context, input);
      }
      if (takeover.status === 'error') return input.loader();
      await this.sleep(this.config.pollIntervalMs);
    }
    throw new CandleSingleFlightWaitTimeoutError();
  }

  private markOwnershipLost(mark: () => void, alreadyLost: boolean): void {
    if (alreadyLost) return;
    mark();
    this.logger.warn('Candle single-flight lock ownership was lost.');
  }
}
