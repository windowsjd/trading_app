import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../redis/redis.service';
import { REDIS_RESERVE_NEXT_AVAILABLE_SCRIPT } from '../../../redis/redis-lua-scripts';
import { RedisUnavailableError } from '../../../redis/redis.types';
import {
  intervalFor,
  readKisRateLimitConfig,
  type KisRateLimitConfig,
} from './kis-rate-limit.config';
import {
  KisRateLimitWaitTimeoutError,
  type KisTrafficClass,
} from './kis-rate-limit.types';

export type KisRateLimitReservation = {
  delayMs: number;
  mode: 'redis' | 'local';
};

@Injectable()
export class KisRateLimiterService {
  private readonly logger = new Logger(KisRateLimiterService.name);
  private readonly localNextAt: Record<KisTrafficClass, number> = {
    oauth: 0,
    rest: 0,
  };
  private distributedOutageLogged = false;

  constructor(
    private readonly redis: RedisService,
    readonly config: KisRateLimitConfig = readKisRateLimitConfig(),
    private readonly now: () => number = Date.now,
  ) {}

  async reserve(
    trafficClass: KisTrafficClass,
  ): Promise<KisRateLimitReservation> {
    if (!this.config.enabled) return { delayMs: 0, mode: 'local' };
    const intervalMs = intervalFor(this.config, trafficClass);
    try {
      const raw = await this.redis.eval(
        REDIS_RESERVE_NEXT_AVAILABLE_SCRIPT,
        [this.keyFor(trafficClass)],
        [
          String(intervalMs),
          String(this.config.maxWaitMs),
          String(this.config.maxWaitMs + intervalMs + 60_000),
        ],
      );
      const delayMs = parseDelay(raw);
      if (delayMs < 0) throw new KisRateLimitWaitTimeoutError();
      if (this.distributedOutageLogged) {
        this.logger.log('Distributed KIS rate limiting restored.');
        this.distributedOutageLogged = false;
      }
      return { delayMs, mode: 'redis' };
    } catch (error) {
      if (!(error instanceof RedisUnavailableError)) throw error;
      if (!this.distributedOutageLogged) {
        this.logger.warn(
          'Distributed KIS rate limiting unavailable; using conservative in-process limiting.',
        );
        this.distributedOutageLogged = true;
      }
      return this.reserveLocally(trafficClass, intervalMs);
    }
  }

  keyFor(trafficClass: KisTrafficClass): string {
    return `kis:rate:v1:${this.config.environment}:${this.config.appKeyHash}:${trafficClass}`;
  }

  private reserveLocally(
    trafficClass: KisTrafficClass,
    intervalMs: number,
  ): KisRateLimitReservation {
    const now = this.now();
    const slotAt = Math.max(now, this.localNextAt[trafficClass]);
    const delayMs = slotAt - now;
    if (delayMs > this.config.maxWaitMs) {
      throw new KisRateLimitWaitTimeoutError();
    }
    this.localNextAt[trafficClass] = slotAt + intervalMs;
    return { delayMs, mode: 'local' };
  }
}

function parseDelay(raw: unknown): number {
  const value = Array.isArray(raw) ? Number(raw[0]) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    throw new RedisUnavailableError('Invalid Redis rate-limit response.');
  }
  return value;
}
