import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AssetType, CurrencyCode } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderBookPubSubService } from '../order-book-pubsub.service';
import type { OrderBookEvent } from '../order-book.types';
import { toBinanceUsdtSymbol } from '../provider-target-resolver.service';
import {
  BINANCE_FIXED_ASSET_UNIVERSE,
  BINANCE_ASSET_MARKET,
} from './binance-fixed-asset-universe';
import { parseBinanceDepth } from './binance-order-book.parser';

export type BinanceOrderBookTarget = {
  assetId: string;
  symbol: string;
  baseAsset: string;
};

/** Shared by both existing owners; no provider socket or financial writes here. */
@Injectable()
export class BinanceOrderBookService implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceOrderBookService.name);
  private readonly sequences = new Map<string, string>();
  private readonly pending = new Map<string, OrderBookEvent>();
  private readonly publishing = new Map<string, Promise<void>>();
  private stopping = false;
  private readonly counts = {
    accepted: 0,
    rejected: 0,
    outOfOrder: 0,
    published: 0,
    publishFailed: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly pubsub: OrderBookPubSubService,
  ) {}

  async loadTargets(): Promise<Map<string, BinanceOrderBookTarget>> {
    const universe = new Map(
      BINANCE_FIXED_ASSET_UNIVERSE.map((entry) => [entry.symbol, entry]),
    );
    const assets = await this.prisma.asset.findMany({
      where: {
        isActive: true,
        assetType: AssetType.crypto,
        market: BINANCE_ASSET_MARKET,
        currencyCode: CurrencyCode.USD,
        symbol: {
          in: BINANCE_FIXED_ASSET_UNIVERSE.flatMap((entry) => [
            entry.symbol,
            entry.baseAsset,
          ]),
        },
      },
      select: { id: true, symbol: true },
    });
    const targets = new Map<string, BinanceOrderBookTarget>();
    const ambiguous = new Set<string>();
    for (const asset of assets) {
      const symbol = toBinanceUsdtSymbol(asset.symbol);
      const entry = symbol ? universe.get(symbol) : undefined;
      if (!symbol || !entry) continue;
      if (targets.has(symbol) || ambiguous.has(symbol)) {
        targets.delete(symbol);
        ambiguous.add(symbol);
        continue;
      }
      targets.set(symbol, {
        assetId: asset.id,
        symbol,
        baseAsset: entry.baseAsset,
      });
    }
    return targets;
  }

  /** True means a depth frame was consumed (including rejected depth). */
  handleFrame(
    frame: string,
    receivedAt: Date,
    targets: ReadonlyMap<string, BinanceOrderBookTarget>,
  ): boolean {
    const parsed = parseBinanceDepth(frame);
    if (parsed.state === 'other') return false;
    if (this.stopping) return true;
    const target =
      parsed.state === 'depth' ? targets.get(parsed.symbol) : undefined;
    if (parsed.state !== 'depth' || !target) {
      this.counts.rejected += 1;
      // Bounded diagnostics: a bad stream cannot flood logs once per frame.
      if (this.counts.rejected === 1 || this.counts.rejected % 100 === 0)
        this.logger.warn('BINANCE_ORDER_BOOK_REJECTED');
      return true;
    }
    const previous = this.sequences.get(target.symbol);
    if (previous !== undefined && BigInt(parsed.sequence) <= BigInt(previous)) {
      this.counts.outOfOrder += 1;
      return true;
    }
    this.sequences.set(target.symbol, parsed.sequence);
    this.counts.accepted += 1;
    this.pending.set(target.symbol, {
      type: 'asset_order_book',
      sequence: parsed.sequence,
      book: {
        assetId: target.assetId,
        priceUnit: 'USDT',
        quantityUnit: target.baseAsset,
        marketLabel: `${target.baseAsset} / USDT`,
        asks: parsed.asks,
        bids: parsed.bids,
        capturedAt: receivedAt.toISOString(),
        effectiveAt: null,
      },
    });
    if (!this.publishing.has(target.symbol)) {
      this.startPublishing(target.symbol);
    }
    return true;
  }

  getStatus() {
    return {
      ...this.counts,
      pending: this.pending.size,
      publishing: this.publishing.size,
    };
  }

  private startPublishing(symbol: string): void {
    const task = this.flush(symbol).finally(() => {
      this.publishing.delete(symbol);
      if (!this.stopping && this.pending.has(symbol))
        this.startPublishing(symbol);
    });
    this.publishing.set(symbol, task);
  }

  private async flush(symbol: string): Promise<void> {
    while (!this.stopping) {
      const event = this.pending.get(symbol);
      if (!event) return;
      this.pending.delete(symbol);
      const published = await this.pubsub.publish(event);
      if (published) this.counts.published += 1;
      else this.counts.publishFailed += 1;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.pending.clear();
    await Promise.allSettled(this.publishing.values());
    this.sequences.clear();
  }
}
