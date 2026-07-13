import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import IORedis from 'ioredis';
import {
  LIVE_CANDLE_CONFIG,
  type LiveCandleConfig,
} from '../assets/live-candle.config';
import type { BinanceRealtimePriceEvent } from '../providers/binance/binance-realtime-price-event-bus.service';
import type { KisRealtimePriceEvent } from '../providers/kis/kis-realtime-price-event-bus.service';
import { readRedisConfig } from '../redis/redis.config';
import { RedisService } from '../redis/redis.service';

export const PROVIDER_PRICE_PUBSUB_CHANNEL =
  'candles:live:v1:provider-price-fanout';

export type ProviderRealtimePriceEvent =
  | BinanceRealtimePriceEvent
  | KisRealtimePriceEvent;

type Listener = (event: ProviderRealtimePriceEvent) => void;

/**
 * Keeps the legacy asset_ticker channel multi-instance while the candle
 * supervisor is the sole provider owner. This channel is intentionally
 * separate from asset_candle snapshots.
 */
@Injectable()
export class ProviderPricePubSubService
  implements OnModuleInit, OnModuleDestroy
{
  private client: IORedis | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly redis: RedisService,
    @Inject(LIVE_CANDLE_CONFIG) private readonly config: LiveCandleConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;
    const redis = readRedisConfig();
    if (!redis.url) return;
    const client = new IORedis(redis.url, {
      lazyConnect: true,
      connectTimeout: redis.connectTimeoutMs,
      commandTimeout: redis.commandTimeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) =>
        Math.min(
          this.config.reconnectMaxMs,
          this.config.reconnectMinMs * 2 ** Math.min(attempt, 8),
        ),
    });
    this.client = client;
    client.on('ready', () => {
      void client.subscribe(PROVIDER_PRICE_PUBSUB_CHANNEL).catch(() => {});
    });
    client.on('message', (channel, message) => {
      if (channel !== PROVIDER_PRICE_PUBSUB_CHANNEL) return;
      const event = parseEvent(message);
      if (!event) return;
      for (const listener of this.listeners) listener(event);
    });
    client.on('error', () => {});
    void client.connect().catch(() => {});
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.unsubscribe(PROVIDER_PRICE_PUBSUB_CHANNEL);
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
    this.listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(event: ProviderRealtimePriceEvent): Promise<boolean> {
    try {
      await this.redis.publish(
        PROVIDER_PRICE_PUBSUB_CHANNEL,
        JSON.stringify(event),
      );
      return true;
    } catch {
      return false;
    }
  }
}

function parseEvent(message: string): ProviderRealtimePriceEvent | null {
  try {
    const event = JSON.parse(message) as Partial<ProviderRealtimePriceEvent>;
    if (
      (event.type !== 'binance_realtime_price' &&
        event.type !== 'kis_realtime_price') ||
      typeof event.assetId !== 'string' ||
      !event.price ||
      typeof event.price.price !== 'string' ||
      typeof event.price.sourceName !== 'string' ||
      typeof event.price.effectiveAt !== 'string' ||
      typeof event.price.capturedAt !== 'string'
    ) {
      return null;
    }
    return event as ProviderRealtimePriceEvent;
  } catch {
    return null;
  }
}
