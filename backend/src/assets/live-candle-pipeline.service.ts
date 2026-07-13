import { Injectable } from '@nestjs/common';
import { LiveCandleHealthService } from './live-candle-health.service';
import { LiveCandleHydratorService } from './live-candle-hydrator.service';
import { LiveCandlePublisherService } from './live-candle-publisher.service';
import { LiveCandleStoreService } from './live-candle-store.service';
import type {
  LiveCandleBaseline,
  LiveCandleStoreUpdateResult,
  NormalizedLiveCandleEvent,
} from './live-candle.types';

@Injectable()
export class LiveCandlePipelineService {
  private readonly activeKeysByProvider = new Map<
    string,
    Map<string, string>
  >();
  private readonly continuityByProvider = new Map<
    string,
    { ownerGeneration: string; since: Date }
  >();

  constructor(
    private readonly store: LiveCandleStoreService,
    private readonly hydrator: LiveCandleHydratorService,
    private readonly publisher: LiveCandlePublisherService,
    private readonly health: LiveCandleHealthService,
  ) {}

  async process(input: {
    event: NormalizedLiveCandleEvent;
    ownerGeneration: string;
    ownerLeaseKey: string;
  }): Promise<LiveCandleStoreUpdateResult> {
    let baseline: LiveCandleBaseline | null = null;
    const current = await this.store.getCurrent(input.event.assetId);
    const sameOwnedBucket =
      current?.ownerGeneration === input.ownerGeneration &&
      current.openTime === input.event.openTime.toISOString();
    const continuity = this.continuityByProvider.get(input.event.provider);
    const continuousFromBucketOpen =
      continuity?.ownerGeneration === input.ownerGeneration &&
      continuity.since.getTime() <= input.event.openTime.getTime();
    if (!sameOwnedBucket && !continuousFromBucketOpen) {
      const hydration = await this.hydrator.hydrate(input.event);
      if (hydration.canonicalClosed) {
        return {
          status: 'baseline_covered',
          state: null,
          stateKey: '',
        };
      }
      baseline = hydration.baseline;
      if (!baseline && input.event.mode === 'delta') {
        this.health.increment('incompleteBuckets');
      }
    }
    const continuousAtBucketOpen =
      continuousFromBucketOpen ||
      (continuity?.ownerGeneration === input.ownerGeneration &&
        baseline?.complete === true &&
        continuity.since.getTime() <= baseline.baselineEventTime.getTime());
    const result = await this.store.applyEvent({
      ...input,
      baseline,
      continuousAtBucketOpen,
    });
    if (result.state) {
      let keys = this.activeKeysByProvider.get(input.event.provider);
      if (!keys) {
        keys = new Map();
        this.activeKeysByProvider.set(input.event.provider, keys);
      }
      keys.set(input.event.assetId, result.stateKey);
    }
    if (
      result.state &&
      (result.status === 'updated' || result.status === 'out_of_order')
    ) {
      await this.publisher.publishState(result.state);
    }
    return result;
  }

  markProviderConnected(input: {
    provider: 'binance' | 'kis';
    ownerGeneration: string;
    connectedAt?: Date;
  }): void {
    const current = this.continuityByProvider.get(input.provider);
    if (current?.ownerGeneration === input.ownerGeneration) return;
    this.continuityByProvider.set(input.provider, {
      ownerGeneration: input.ownerGeneration,
      since: input.connectedAt ?? new Date(),
    });
  }

  async markProviderContinuityLost(input: {
    provider: 'binance' | 'kis';
    ownerGeneration: string;
    ownerLeaseKey: string;
  }): Promise<void> {
    const keys = this.activeKeysByProvider.get(input.provider);
    if (keys) {
      await Promise.allSettled(
        [...keys.values()].map((stateKey) =>
          this.store.markIncomplete({ ...input, stateKey }),
        ),
      );
      keys.clear();
    }
    const continuity = this.continuityByProvider.get(input.provider);
    if (continuity?.ownerGeneration === input.ownerGeneration) {
      this.continuityByProvider.delete(input.provider);
    }
  }
}
