import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisLockService, type RedisLock } from '../redis/redis-lock.service';
import type { AssetCandlesResponse } from './asset-candles.service';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import {
  buildCandleDataKey,
  type CandleCacheKeyInput,
} from './asset-candles-cache.keys';
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
    // Build once for validation and a stable local identity. Generation zero is
    // only a validation aid; the cache service still owns generation lookup.
    const identity = buildCandleDataKey({
      ...input.cacheKeyInput,
      generation: 0,
    });
    const initial = await this.cache.get(input.cacheKeyInput);
    if (initial.status === 'hit') return initial.value;

    const existing = this.inFlight.get(identity);
    if (existing) return existing;

    const promise = this.coordinate(identity, input);
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
    input: CandleSingleFlightInput,
  ): Promise<AssetCandlesResponse> {
    if (!this.cache.isEnabled()) return input.loader();

    const key = `candles:lock:v1:${createHash('sha256')
      .update(identity)
      .digest('hex')}`;
    const acquired = await this.locks.acquire(key, this.config.lockTtlMs);
    if (acquired.status === 'error') return input.loader();
    if (acquired.status === 'acquired') {
      return this.loadAsOwner(acquired.lock, input);
    }
    return this.waitForOwner(key, input);
  }

  private async loadAsOwner(
    lock: RedisLock,
    input: CandleSingleFlightInput,
  ): Promise<AssetCandlesResponse> {
    let ownershipLost = false;
    let finished = false;
    const renewal = setInterval(() => {
      void this.locks.extend(lock, this.config.lockTtlMs).then((extended) => {
        if (!finished && !extended && !ownershipLost) {
          ownershipLost = true;
          this.logger.warn('Candle single-flight lock ownership was lost.');
        }
      });
    }, this.config.renewIntervalMs);

    try {
      const doubleCheck = await this.cache.get(input.cacheKeyInput);
      if (doubleCheck.status === 'hit') return doubleCheck.value;
      const value = await input.loader();
      // Operational cache failures are returned as status:error and do not
      // turn a successful provider load into a user-visible failure.
      await this.cache.set(input.cacheKeyInput, value);
      return value;
    } finally {
      finished = true;
      clearInterval(renewal);
      await this.locks.release(lock);
    }
  }

  private async waitForOwner(
    key: string,
    input: CandleSingleFlightInput,
  ): Promise<AssetCandlesResponse> {
    const deadline = this.now() + this.config.waitTimeoutMs;
    while (this.now() < deadline) {
      await this.sleep(this.config.pollIntervalMs);
      const cached = await this.cache.get(input.cacheKeyInput);
      if (cached.status === 'hit') return cached.value;
      if (cached.status === 'error' || cached.status === 'disabled') {
        return input.loader();
      }
    }

    // The original lock may have expired. Make one bounded takeover attempt.
    const retry = await this.locks.acquire(key, this.config.lockTtlMs);
    if (retry.status === 'acquired') return this.loadAsOwner(retry.lock, input);
    if (retry.status === 'error') return input.loader();
    throw new CandleSingleFlightWaitTimeoutError();
  }
}
