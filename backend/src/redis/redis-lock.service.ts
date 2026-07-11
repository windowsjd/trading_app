import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from './redis.service';
import {
  REDIS_COMPARE_AND_DELETE_SCRIPT,
  REDIS_COMPARE_AND_EXPIRE_SCRIPT,
} from './redis-lua-scripts';
import { RedisKeyError, RedisUnavailableError } from './redis.types';

export type RedisLock = { key: string; token: string; ttlMs: number };
export type RedisLockAcquireResult =
  | { status: 'acquired'; lock: RedisLock }
  | { status: 'busy' }
  | { status: 'error' };

@Injectable()
export class RedisLockService {
  constructor(private readonly redis: RedisService) {}

  async acquire(key: string, ttlMs: number): Promise<RedisLockAcquireResult> {
    this.requireTtl(ttlMs);
    const token = randomUUID();
    try {
      const acquired = await this.redis.setNxPx(key, token, ttlMs);
      return acquired
        ? { status: 'acquired', lock: { key, token, ttlMs } }
        : { status: 'busy' };
    } catch (error) {
      if (error instanceof RedisUnavailableError) return { status: 'error' };
      throw error;
    }
  }

  async release(lock: RedisLock): Promise<boolean> {
    this.requireLock(lock);
    try {
      return (
        Number(
          await this.redis.eval(
            REDIS_COMPARE_AND_DELETE_SCRIPT,
            [lock.key],
            [lock.token],
          ),
        ) === 1
      );
    } catch (error) {
      if (error instanceof RedisUnavailableError) return false;
      throw error;
    }
  }

  async extend(lock: RedisLock, ttlMs: number = lock.ttlMs): Promise<boolean> {
    this.requireLock(lock);
    this.requireTtl(ttlMs);
    try {
      return (
        Number(
          await this.redis.eval(
            REDIS_COMPARE_AND_EXPIRE_SCRIPT,
            [lock.key],
            [lock.token, String(ttlMs)],
          ),
        ) === 1
      );
    } catch (error) {
      if (error instanceof RedisUnavailableError) return false;
      throw error;
    }
  }

  private requireTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new RedisKeyError('Redis lock ttlMs must be a positive integer.');
    }
  }

  private requireLock(lock: RedisLock): void {
    if (!lock || !lock.key || !lock.token) {
      throw new RedisKeyError('Redis lock key and token are required.');
    }
  }
}
