import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import IORedis from 'ioredis';
import { readRedisConfig } from '../redis/redis.config';
import { RedisService } from '../redis/redis.service';
import { parseOrderBookEvent, type OrderBookEvent } from './order-book.types';

export const ORDER_BOOK_CHANNEL = 'market:order-book:v1';

/** Transient cross-instance fanout, independent of the live-candle feature gate. */
@Injectable()
export class OrderBookPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderBookPubSubService.name);
  private client: IORedis | null = null;
  private readonly listeners = new Set<(event: OrderBookEvent) => void>();
  private publishUnavailable = false;

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    const config = readRedisConfig();
    if (!config.url) return;
    const client = new IORedis(config.url, {
      lazyConnect: true,
      connectTimeout: config.connectTimeoutMs,
      commandTimeout: config.commandTimeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) =>
        Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 8)),
    });
    this.client = client;
    client.on('ready', () => {
      void client.subscribe(ORDER_BOOK_CHANNEL).catch(() => {});
    });
    client.on('message', (channel: string, message: string) => {
      if (channel !== ORDER_BOOK_CHANNEL) return;
      const event = parseOrderBookEvent(message);
      if (!event) return;
      for (const listener of this.listeners) listener(event);
    });
    client.on('error', () => {});
    void client.connect().catch(() => {});
  }

  subscribe(listener: (event: OrderBookEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async publish(event: OrderBookEvent): Promise<boolean> {
    try {
      await this.redis.publish(ORDER_BOOK_CHANNEL, JSON.stringify(event));
      this.publishUnavailable = false;
      return true;
    } catch {
      if (!this.publishUnavailable)
        this.logger.warn('ORDER_BOOK_PUBLISH_FAILED');
      this.publishUnavailable = true;
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.listeners.clear();
    if (!client) return;
    try {
      await client.unsubscribe(ORDER_BOOK_CHANNEL);
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}
