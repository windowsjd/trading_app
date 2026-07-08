import { Injectable } from '@nestjs/common';
import type { BinanceWebSocketTicker } from './binance-websocket.types';

export type BinanceRealtimePriceCacheEntry = {
  key: string;
  providerSymbol: string;
  streamName: string | null;
  price: string;
  changeRate: string | null;
  bidPrice: string | null;
  askPrice: string | null;
  currencyCode: 'USD';
  sourceName: string;
  effectiveAt: string;
  capturedAt: string;
  updatedAt: string;
};

@Injectable()
export class BinanceRealtimePriceCacheService {
  private readonly prices = new Map<string, BinanceRealtimePriceCacheEntry>();

  updateFromTicker(input: {
    ticker: BinanceWebSocketTicker;
    sourceName: string;
  }): BinanceRealtimePriceCacheEntry {
    const key = input.ticker.providerSymbol.trim().toUpperCase();
    const entry: BinanceRealtimePriceCacheEntry = {
      key,
      providerSymbol: key,
      streamName: input.ticker.streamName,
      price: input.ticker.price,
      changeRate: input.ticker.changeRate,
      bidPrice: input.ticker.bidPrice,
      askPrice: input.ticker.askPrice,
      currencyCode: 'USD',
      sourceName: input.sourceName,
      effectiveAt: input.ticker.effectiveAt.toISOString(),
      capturedAt: input.ticker.receivedAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.prices.set(key, entry);
    return entry;
  }

  getBySymbol(symbol: string): BinanceRealtimePriceCacheEntry | null {
    return this.prices.get(symbol.trim().toUpperCase()) ?? null;
  }

  getAll(): BinanceRealtimePriceCacheEntry[] {
    return [...this.prices.values()];
  }

  clear(): void {
    this.prices.clear();
  }
}
