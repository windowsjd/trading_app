import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { KisRateLimiterService } from './kis-rate-limiter.service';
import {
  KisRateLimitQueueFullError,
  KisRateLimitShutdownError,
  KisRateLimitWaitTimeoutError,
  type KisTrafficClass,
} from './kis-rate-limit.types';

type QueueItem = {
  enqueuedAt: number;
  settled: boolean;
  timeout: NodeJS.Timeout;
  cancelWait?: () => void;
  cleanup?: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
};

@Injectable()
export class KisRequestCoordinatorService implements OnModuleDestroy {
  private readonly queues: Record<KisTrafficClass, QueueItem[]> = {
    oauth: [],
    rest: [],
  };
  private readonly processing: Record<KisTrafficClass, boolean> = {
    oauth: false,
    rest: false,
  };
  private readonly active: Record<KisTrafficClass, QueueItem | null> = {
    oauth: null,
    rest: null,
  };
  private shuttingDown = false;

  constructor(
    private readonly limiter: KisRateLimiterService,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(
    trafficClass: KisTrafficClass,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.limiter.config.enabled) return Promise.resolve();
    if (this.shuttingDown)
      return Promise.reject(new KisRateLimitShutdownError());
    const queue = this.queues[trafficClass];
    const queuedCount = (['oauth', 'rest'] as const).reduce(
      (total, bucket) =>
        total + this.queues[bucket].filter((item) => !item.settled).length,
      0,
    );
    if (queuedCount >= this.limiter.config.maxQueueSize) {
      return Promise.reject(new KisRateLimitQueueFullError());
    }

    return new Promise<void>((resolve, reject) => {
      const item = {} as QueueItem;
      item.enqueuedAt = this.now();
      item.settled = false;
      item.resolve = resolve;
      item.reject = reject;
      item.timeout = setTimeout(() => {
        this.rejectItem(item, new KisRateLimitWaitTimeoutError());
      }, this.limiter.config.maxWaitMs);

      if (options.signal) {
        const abort = () =>
          this.rejectItem(item, new KisRateLimitWaitTimeoutError());
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
        item.cleanup = () =>
          options.signal?.removeEventListener('abort', abort);
      }
      queue.push(item);
      void this.pump(trafficClass);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const trafficClass of ['oauth', 'rest'] as const) {
      const active = this.active[trafficClass];
      if (active) this.rejectItem(active, new KisRateLimitShutdownError());
      for (const item of this.queues[trafficClass]) {
        this.rejectItem(item, new KisRateLimitShutdownError());
      }
      this.queues[trafficClass] = [];
    }
  }

  private async pump(trafficClass: KisTrafficClass): Promise<void> {
    if (this.processing[trafficClass]) return;
    this.processing[trafficClass] = true;
    const queue = this.queues[trafficClass];
    try {
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.settled) continue;
        this.active[trafficClass] = item;
        try {
          const reservation = await this.limiter.reserve(trafficClass);
          if (item.settled) continue;
          const elapsed = this.now() - item.enqueuedAt;
          if (elapsed + reservation.delayMs > this.limiter.config.maxWaitMs) {
            throw new KisRateLimitWaitTimeoutError();
          }
          if (reservation.delayMs > 0)
            await this.wait(item, reservation.delayMs);
          if (!item.settled) {
            item.settled = true;
            clearTimeout(item.timeout);
            item.cleanup?.();
            item.resolve();
          }
        } catch (error) {
          this.rejectItem(
            item,
            error instanceof Error ? error : new KisRateLimitWaitTimeoutError(),
          );
        } finally {
          if (this.active[trafficClass] === item) {
            this.active[trafficClass] = null;
          }
        }
      }
    } finally {
      this.processing[trafficClass] = false;
      if (queue.length > 0) void this.pump(trafficClass);
    }
  }

  private wait(item: QueueItem, delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      item.cancelWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private rejectItem(item: QueueItem, error: Error): void {
    if (item.settled) return;
    item.settled = true;
    clearTimeout(item.timeout);
    item.cancelWait?.();
    item.cleanup?.();
    item.reject(error);
  }
}
