import { Injectable } from '@nestjs/common';
import { CurrencyCode } from '../../generated/prisma/client';
import { sourceNameForKisTrade } from './kis-websocket.ingestion.service';
import type { KisWebSocketTradeTick } from './kis-websocket.types';

export type KisRealtimePriceCacheEntry = {
  key: string;
  kind: KisWebSocketTradeTick['kind'];
  trId: string;
  providerSymbol: string;
  symbol: string;
  marketCode: string | null;
  price: string;
  currencyCode: CurrencyCode;
  sourceName: string;
  effectiveAt: string;
  capturedAt: string;
  updatedAt: string;
};

@Injectable()
export class KisRealtimePriceCacheService {
  private readonly prices = new Map<string, KisRealtimePriceCacheEntry>();

  updateFromTrade(trade: KisWebSocketTradeTick): KisRealtimePriceCacheEntry {
    const effectiveAt = trade.sourceTimestamp ?? trade.receivedAt;
    const entry: KisRealtimePriceCacheEntry = {
      key: this.keyForTrade(trade),
      kind: trade.kind,
      trId: trade.trId,
      providerSymbol: trade.providerSymbol,
      symbol: trade.symbol,
      marketCode: trade.marketCode,
      price: trade.price,
      currencyCode:
        trade.kind === 'domestic_krx_realtime_trade'
          ? CurrencyCode.KRW
          : CurrencyCode.USD,
      sourceName: sourceNameForKisTrade(trade),
      effectiveAt: effectiveAt.toISOString(),
      capturedAt: trade.receivedAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.prices.set(entry.key, entry);
    return entry;
  }

  getByKey(key: string): KisRealtimePriceCacheEntry | null {
    return this.prices.get(key) ?? null;
  }

  getBySymbol(input: {
    symbol: string;
    kind: KisWebSocketTradeTick['kind'];
  }): KisRealtimePriceCacheEntry | null {
    return (
      this.prices.get(
        this.keyForSymbol({
          symbol: input.symbol,
          kind: input.kind,
        }),
      ) ?? null
    );
  }

  getAll(): KisRealtimePriceCacheEntry[] {
    return [...this.prices.values()];
  }

  clear(): void {
    this.prices.clear();
  }

  private keyForTrade(trade: KisWebSocketTradeTick): string {
    return this.keyForSymbol({
      symbol: trade.symbol,
      kind: trade.kind,
    });
  }

  private keyForSymbol(input: {
    symbol: string;
    kind: KisWebSocketTradeTick['kind'];
  }): string {
    return `${input.kind}:${input.symbol.trim().toUpperCase()}`;
  }
}
