import { Injectable } from '@nestjs/common';
import { MarketCandleSyncMode } from '../generated/prisma/client';
import { MarketCandlesRepository } from './market-candles.repository';
import { MarketCandleSyncService } from './market-candle-sync.service';
import type {
  LiveCandleBaseline,
  NormalizedLiveCandleEvent,
} from './live-candle.types';

export type LiveCandleHydrationResult = {
  baseline: LiveCandleBaseline | null;
  canonicalClosed: boolean;
};

@Injectable()
export class LiveCandleHydratorService {
  private readonly inFlight = new Map<
    string,
    Promise<LiveCandleHydrationResult>
  >();

  constructor(
    private readonly repository: MarketCandlesRepository,
    private readonly sync: MarketCandleSyncService,
  ) {}

  hydrate(
    event: NormalizedLiveCandleEvent,
  ): Promise<LiveCandleHydrationResult> {
    if (event.mode === 'absolute') {
      return Promise.resolve({ baseline: null, canonicalClosed: false });
    }
    const key = `${event.assetId}:${event.openTime.getTime()}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.hydrateOnce(event).finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async hydrateOnce(
    event: NormalizedLiveCandleEvent,
  ): Promise<LiveCandleHydrationResult> {
    let row = await this.findBucket(event);
    if (!row) {
      try {
        await this.sync.syncAsset({
          assetId: event.assetId,
          targets: ['5m'],
          mode: MarketCandleSyncMode.repair,
          from: event.openTime,
          to: event.closeTime,
          resume: false,
          now: event.receivedAt,
          budget: {
            maxPages: 2,
            maxRows: 500,
            maxDurationMs: 5_000,
          },
        });
        row = await this.findBucket(event);
      } catch {
        // A missing baseline is explicit and safe: the reducer keeps the
        // provisional candle incomplete and reconciliation repairs it later.
      }
    }
    if (!row) return { baseline: null, canonicalClosed: false };
    return {
      canonicalClosed: row.isClosed,
      baseline: {
        open: row.open.toFixed(8),
        high: row.high.toFixed(8),
        low: row.low.toFixed(8),
        close: row.close.toFixed(8),
        volume: row.volume.toFixed(8),
        amount: row.amount?.toFixed(8) ?? null,
        firstEventAt: row.openTime,
        lastEventAt: row.sourceUpdatedAt,
        sourceUpdatedAt: row.sourceUpdatedAt,
        complete: true,
        baselineEventTime: row.sourceUpdatedAt,
      },
    };
  }

  private async findBucket(event: NormalizedLiveCandleEvent) {
    const rows = await this.repository.findRange({
      assetId: event.assetId,
      interval: '5m',
      from: event.openTime,
      to: event.closeTime,
    });
    return (
      rows.find((row) => row.openTime.getTime() === event.openTime.getTime()) ??
      null
    );
  }
}
