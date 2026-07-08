import { Injectable, Logger } from '@nestjs/common';
import type { BinanceRealtimePriceCacheEntry } from './binance-realtime-price-cache.service';
import type { BinanceWebSocketTickerSummary } from './binance-websocket.types';

export type BinanceRealtimePriceEvent = {
  type: 'binance_realtime_price';
  price: BinanceRealtimePriceCacheEntry;
  assetId: string | null;
  snapshotState: BinanceWebSocketTickerSummary['state'] | null;
  snapshotReason?: string;
};

export type BinanceRealtimePriceEventListener = (
  event: BinanceRealtimePriceEvent,
) => void | Promise<void>;

@Injectable()
export class BinanceRealtimePriceEventBus {
  private readonly logger = new Logger(BinanceRealtimePriceEventBus.name);
  private readonly listeners = new Set<BinanceRealtimePriceEventListener>();

  subscribe(listener: BinanceRealtimePriceEventListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: BinanceRealtimePriceEvent): void {
    for (const listener of this.listeners) {
      void Promise.resolve(listener(event)).catch((error: unknown) => {
        this.logger.warn(
          `Binance realtime price listener failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
