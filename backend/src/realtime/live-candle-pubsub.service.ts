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
import { LIVE_CANDLE_PUBSUB_CHANNEL } from '../assets/live-candle-publisher.service';
import type { AssetCandleSnapshotEvent } from '../assets/live-candle.types';
import { readRedisConfig } from '../redis/redis.config';

export type LiveCandlePubSubStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'unavailable';

type EventListener = (event: AssetCandleSnapshotEvent) => void;
type StatusListener = (status: LiveCandlePubSubStatus) => void;

@Injectable()
export class LiveCandlePubSubService implements OnModuleInit, OnModuleDestroy {
  private client: IORedis | null = null;
  private readonly listeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private status: LiveCandlePubSubStatus = 'disabled';

  constructor(
    @Inject(LIVE_CANDLE_CONFIG) private readonly config: LiveCandleConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;
    const redis = readRedisConfig();
    if (!redis.url) {
      this.setStatus('unavailable');
      return;
    }
    this.setStatus('connecting');
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
      void client
        .subscribe(LIVE_CANDLE_PUBSUB_CHANNEL)
        .then(() => this.setStatus('connected'))
        .catch(() => this.setStatus('unavailable'));
    });
    client.on('message', (channel, message) => {
      if (channel !== LIVE_CANDLE_PUBSUB_CHANNEL) return;
      const event = parseEvent(message);
      if (!event) return;
      for (const listener of this.listeners) listener(event);
    });
    client.on('error', () => this.setStatus('unavailable'));
    client.on('close', () => this.setStatus('unavailable'));
    void client.connect().catch(() => this.setStatus('unavailable'));
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.unsubscribe(LIVE_CANDLE_PUBSUB_CHANNEL);
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
    this.listeners.clear();
    this.statusListeners.clear();
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): LiveCandlePubSubStatus {
    return this.status;
  }

  /** Test/fixture entry point; production fanout still arrives via Redis. */
  dispatchFixture(event: AssetCandleSnapshotEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setStatus(status: LiveCandlePubSubStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

function parseEvent(message: string): AssetCandleSnapshotEvent | null {
  try {
    const event = JSON.parse(message) as Partial<AssetCandleSnapshotEvent>;
    if (
      event.type !== 'asset_candle' ||
      typeof event.assetId !== 'string' ||
      typeof event.interval !== 'string' ||
      typeof event.sequence !== 'number' ||
      typeof event.revision !== 'number' ||
      !event.candle ||
      typeof event.candle.time !== 'string'
    ) {
      return null;
    }
    return event as AssetCandleSnapshotEvent;
  } catch {
    return null;
  }
}
