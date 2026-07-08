import { Injectable, Logger } from '@nestjs/common';
import type { KisRealtimePriceCacheEntry } from './kis-realtime-price-cache.service';
import type { KisSnapshotIngestionState } from './kis-websocket.types';

export type KisRealtimePriceEvent = {
  type: 'kis_realtime_price';
  price: KisRealtimePriceCacheEntry;
  assetId: string | null;
  snapshotState: KisSnapshotIngestionState | null;
  snapshotReason?: string;
};

export type KisRealtimePriceEventListener = (
  event: KisRealtimePriceEvent,
) => void | Promise<void>;

@Injectable()
export class KisRealtimePriceEventBus {
  private readonly logger = new Logger(KisRealtimePriceEventBus.name);
  private readonly listeners = new Set<KisRealtimePriceEventListener>();

  subscribe(listener: KisRealtimePriceEventListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: KisRealtimePriceEvent): void {
    for (const listener of this.listeners) {
      void Promise.resolve(listener(event)).catch((error: unknown) => {
        this.logger.warn(
          `KIS realtime price listener failed: ${errorMessage(error)}`,
        );
      });
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
