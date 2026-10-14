import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { verifiedFuturesInstrument } from '../futures/futures-instrument-coverage';
import {
  futuresBaseAsset,
  futuresMarketLabel,
  type FuturesOrderBook,
} from '../futures/futures-market-data';
import { BinanceOrderBookService } from './binance/binance-order-book.service';
import type { AssetOrderBook } from './order-book.types';

/** The units and label accepted for a mapped asset's order-book stream. */
export type MarketOrderBookTarget = {
  assetId: string;
  priceUnit: string;
  quantityUnit: string;
  marketLabel: string;
};

/** A USDⓈ-M contract's book: keyed by instrument, never by underlying asset. */
export type FuturesOrderBookTarget = {
  instrumentId: string;
  symbol: string;
  priceUnit: string;
  quantityUnit: string;
  marketLabel: string;
};

/** Provider mapping and supported universe remain behind this boundary. */
@Injectable()
export class MarketOrderBookSubscriptionService {
  constructor(
    private readonly binance: BinanceOrderBookService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

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

  /** Same instruments as the app catalog: active, offered, contract-verified. */
  async loadFuturesTarget(
    instrumentId: string,
    now = new Date(),
  ): Promise<FuturesOrderBookTarget | null> {
    if (!this.prisma || !instrumentId || instrumentId.length > 80) return null;
    const instrument = await this.prisma.futuresInstrument.findUnique({
      where: { id: instrumentId },
      include: { underlyingAsset: true },
    });
    if (!instrument || !verifiedFuturesInstrument(instrument, now)) return null;
    const symbol = instrument.underlyingAsset.symbol;
    return {
      instrumentId: instrument.id,
      symbol,
      priceUnit: 'USDT',
      quantityUnit: futuresBaseAsset(symbol),
      marketLabel: futuresMarketLabel(symbol),
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

export function matchesFuturesOrderBookTarget(
  book: FuturesOrderBook,
  target: FuturesOrderBookTarget,
): boolean {
  return (
    book.instrumentId === target.instrumentId &&
    book.symbol === target.symbol &&
    book.priceUnit === target.priceUnit &&
    book.quantityUnit === target.quantityUnit &&
    book.marketLabel === target.marketLabel
  );
}
