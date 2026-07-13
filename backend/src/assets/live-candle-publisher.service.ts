import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { LiveCandleHealthService } from './live-candle-health.service';
import { LiveCandleOverlayService } from './live-candle-overlay.service';
import type {
  AssetCandleSnapshotEvent,
  LiveFiveMinuteCandleState,
} from './live-candle.types';

export const LIVE_CANDLE_PUBSUB_CHANNEL = 'candles:live:v1:fanout';
const LIVE_CANDLE_SEQUENCE_KEY = 'candles:live:v1:sequence';

@Injectable()
export class LiveCandlePublisherService {
  constructor(
    private readonly redis: RedisService,
    private readonly overlay: LiveCandleOverlayService,
    private readonly health: LiveCandleHealthService,
  ) {}

  async publishState(
    state: LiveFiveMinuteCandleState,
  ): Promise<AssetCandleSnapshotEvent[]> {
    const snapshots = await this.overlay.buildCurrentSnapshots(state);
    const published: AssetCandleSnapshotEvent[] = [];
    for (const snapshot of snapshots) {
      try {
        const sequence = await this.redis.increment(LIVE_CANDLE_SEQUENCE_KEY);
        const event = { ...snapshot, sequence };
        await this.redis.publish(
          LIVE_CANDLE_PUBSUB_CHANNEL,
          JSON.stringify(event),
        );
        published.push(event);
      } catch {
        this.health.increment('pubSubPublishFailure');
      }
    }
    return published;
  }
}
