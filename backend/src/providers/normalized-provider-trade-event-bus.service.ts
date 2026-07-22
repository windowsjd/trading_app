import { Injectable, Logger } from '@nestjs/common';
import type { AssetType, CurrencyCode } from '../generated/prisma/client';

/**
 * Already-validated asset metadata carried on the tick.
 *
 * The canonical connection read these columns once, when it built the
 * subscription for the current connection generation. Carrying them on the
 * event is what lets the publisher append to the Redis Stream without a
 * per-trade `SELECT ... FROM assets`. It is a routing optimisation only:
 * every financial decision still re-reads and re-validates the asset inside
 * the execution transaction, so a stale value can never cause a fill.
 */
export type NormalizedProviderTradeAsset = {
  assetId: string;
  symbol: string;
  market: string;
  assetType: AssetType;
  settlementCurrency: CurrencyCode;
  /** Connection generation the metadata was captured under. */
  generation: string;
};

/**
 * Secret-free, provider-normalized live trade boundary. Provider streaming
 * services publish here only after parser validation and asset resolution.
 * Raw payloads, credentials, bid/ask and candle values are deliberately not
 * part of this type.
 */
export type NormalizedProviderTradeTick = {
  provider: 'kis' | 'binance';
  providerEventId: string | null;
  providerSequence: string | null;
  providerConnectionId: string | null;
  assetId: string;
  symbol: string;
  providerSymbol: string;
  price: string;
  currencyCode: CurrencyCode;
  providerEventAt: string;
  receivedAt: string;
  sourceName: string;
  marketSessionCode: string | null;
  eventType: 'trade';
  /** Present for canonical-connection publishers; absent for legacy callers. */
  asset?: NormalizedProviderTradeAsset;
};

type Listener = (event: NormalizedProviderTradeTick) => void | Promise<void>;

@Injectable()
export class NormalizedProviderTradeEventBus {
  private readonly logger = new Logger(NormalizedProviderTradeEventBus.name);
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: NormalizedProviderTradeTick): void {
    for (const listener of this.listeners) {
      void Promise.resolve(listener(event)).catch((error: unknown) => {
        this.logger.error(
          `Normalized trade listener failed (${event.provider}, ${event.assetId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }
}
