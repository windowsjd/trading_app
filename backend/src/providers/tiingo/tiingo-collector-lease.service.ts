import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  RedisLockService,
  type RedisLock,
} from '../../redis/redis-lock.service';
import { TiingoConfigService } from './tiingo.config';
import { TiingoStreamService } from './tiingo-stream.service';

export const TIINGO_COLLECTOR_LEASE_KEY = 'tiingo:collector:v1:owner';
const LEASE_TTL_MS = 30_000;
const RENEW_MS = 10_000;
const RETRY_MS = 10_000;

export type TiingoCollectorLeaseState =
  | 'disabled'
  | 'standby'
  | 'owner'
  | 'unavailable'
  | 'stopped';

export type TiingoCollectorLeaseStatus = {
  state: TiingoCollectorLeaseState;
  acquiredAt: string | null;
  lostAt: string | null;
  lastErrorCode: string | null;
};

/**
 * Official mode (2026-10-17): exactly one server collects Tiingo. The holder
 * of a Redis lease (SET NX PX, renewed every 10 s, 30 s TTL — the live-candle
 * owner pattern) opens the WebSocket and is the only writer of Tiingo
 * snapshots; every other instance serves the stored snapshots and the Redis
 * fan-out. Losing the lease (or Redis) stops the socket at once: without a
 * lease nothing is collected (fail closed, never a duplicate collector).
 * The trial mode keeps its single-instance behavior and takes no lease.
 */
@Injectable()
export class TiingoCollectorLeaseService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TiingoCollectorLeaseService.name);
  private lock: RedisLock | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly status: TiingoCollectorLeaseStatus = {
    state: 'disabled',
    acquiredAt: null,
    lostAt: null,
    lastErrorCode: null,
  };

  constructor(
    private readonly config: TiingoConfigService,
    private readonly locks: RedisLockService,
    @Optional() private readonly stream?: TiingoStreamService,
  ) {}

  onModuleInit(): void {
    const config = this.config.getConfig();
    if (!config.enabled || config.trialMode) return;
    this.status.state = 'standby';
    void this.cycle();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const lock = this.lock;
    this.lock = null;
    this.status.state = 'stopped';
    if (lock) await this.locks.release(lock).catch(() => false);
  }

  /** True only while this instance holds the collector lease. */
  owned(): boolean {
    return this.lock !== null;
  }

  getStatus(): TiingoCollectorLeaseStatus {
    return { ...this.status };
  }

  /** One acquire-or-renew step; exposed for tests. */
  async cycle(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.lock) {
        if (!(await this.locks.extend(this.lock, LEASE_TTL_MS)))
          this.lose('TIINGO_COLLECTOR_LEASE_LOST');
      } else {
        const result = await this.locks.acquire(
          TIINGO_COLLECTOR_LEASE_KEY,
          LEASE_TTL_MS,
        );
        if (result.status === 'acquired') this.gain(result.lock);
        else if (result.status === 'busy') this.status.state = 'standby';
        else {
          this.status.state = 'unavailable';
          this.status.lastErrorCode = 'TIINGO_COLLECTOR_LEASE_UNAVAILABLE';
        }
      }
    } catch {
      if (this.lock) this.lose('TIINGO_COLLECTOR_LEASE_UNAVAILABLE');
      this.status.state = 'unavailable';
      this.status.lastErrorCode = 'TIINGO_COLLECTOR_LEASE_UNAVAILABLE';
    }
    if (this.stopped) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.cycle();
      },
      this.lock ? RENEW_MS : RETRY_MS,
    );
    this.timer.unref?.();
  }

  private gain(lock: RedisLock): void {
    this.lock = lock;
    this.status.state = 'owner';
    this.status.acquiredAt = new Date().toISOString();
    this.status.lastErrorCode = null;
    this.logger.log('Tiingo collector lease acquired.');
    void this.stream?.start();
  }

  private lose(code: string): void {
    this.lock = null;
    this.status.state = 'standby';
    this.status.lostAt = new Date().toISOString();
    this.status.lastErrorCode = code;
    this.logger.warn(`Tiingo collector lease lost (${code}).`);
    void this.stream?.stop();
  }
}
