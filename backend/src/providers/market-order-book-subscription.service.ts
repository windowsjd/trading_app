import { Injectable } from '@nestjs/common';
import { BinanceOrderBookService } from './binance/binance-order-book.service';
import type { AssetOrderBook } from './order-book.types';

/** The units and label accepted for a mapped asset's order-book stream. */
export type MarketOrderBookTarget = {
  assetId: string;
  priceUnit: string;
  quantityUnit: string;
  marketLabel: string;
};

/** Provider mapping and supported universe remain behind this boundary. */
@Injectable()
export class MarketOrderBookSubscriptionService {
  constructor(private readonly binance: BinanceOrderBookService) {}

  async loadTarget(assetId: string): Promise<MarketOrderBookTarget | null> {
    const targets = await this.binance.loadTargets();
    const target = [...targets.values()].find(
      (entry) => entry.assetId === assetId,
    );
    if (!target) return null;
    return {
      assetId: target.assetId,
      priceUnit: 'USDT',
      quantityUnit: target.baseAsset,
      marketLabel: `${target.baseAsset} / USDT`,
    };
  }
}

export function matchesMarketOrderBookTarget(
  book: AssetOrderBook,
  target: MarketOrderBookTarget,
): boolean {
  return (
    book.assetId === target.assetId &&
    book.priceUnit === target.priceUnit &&
    book.quantityUnit === target.quantityUnit &&
    book.marketLabel === target.marketLabel
  );
}
