import { Injectable, Logger, Optional } from '@nestjs/common';
import type { AssetType, CurrencyCode } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BinanceSymbolMetadataService } from '../providers/binance/binance-symbol-metadata.service';

export type RealtimeAssetMetadata = {
  assetId: string;
  symbol: string;
  name: string;
  assetType: AssetType;
  market: string;
  priceCurrency: CurrencyCode;
  /** Read live from the in-memory Binance metadata cache on every call. */
  displayPriceDecimals: number | null;
};

type CacheSlot = {
  /** null = negative entry (unknown or inactive asset). */
  entry: Omit<RealtimeAssetMetadata, 'displayPriceDecimals'> | null;
  expiresAt: number;
};

/** Asset identity fields change rarely; minutes of staleness is acceptable. */
const POSITIVE_TTL_MS = 5 * 60 * 1000;
/** Unknown/inactive ids are re-checked sooner so re-activation is picked up. */
const NEGATIVE_TTL_MS = 30 * 1000;

/**
 * Per-asset identity metadata for the realtime ticker fanout path.
 *
 * A realtime price event needs only static asset identity (symbol, name,
 * currency, display precision) — nothing from `asset_price_snapshots`. This
 * cache answers those lookups from memory so the gateway does NOT hit the DB
 * for every provider tick; only a cache miss (first event per asset, or TTL
 * expiry) queries the `assets` table. Inactive or unknown assets are cached
 * negatively and rejected. A DB failure serves the last known entry (or null)
 * instead of breaking the fanout path.
 */
@Injectable()
export class RealtimeAssetMetadataCacheService {
  private readonly logger = new Logger(RealtimeAssetMetadataCacheService.name);
  private readonly cache = new Map<string, CacheSlot>();
  private readonly inFlight = new Map<string, Promise<CacheSlot['entry']>>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly binanceSymbolMetadata?: BinanceSymbolMetadataService,
  ) {}

  /** Metadata for an active asset, or null for unknown/inactive ids. */
  async getMetadata(assetId: string): Promise<RealtimeAssetMetadata | null> {
    const id = assetId.trim();
    if (!id) return null;

    const now = Date.now();
    const cached = this.cache.get(id);
    if (cached && now < cached.expiresAt) {
      return this.withDisplayDecimals(cached.entry);
    }

    // Coalesce concurrent misses for the same asset into one query.
    let pending = this.inFlight.get(id);
    if (!pending) {
      pending = this.loadFromDatabase(id, cached).finally(() => {
        this.inFlight.delete(id);
      });
      this.inFlight.set(id, pending);
    }

    return this.withDisplayDecimals(await pending);
  }

  /** Drops one asset (or everything) so the next event re-reads the DB. */
  invalidate(assetId?: string): void {
    if (assetId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(assetId.trim());
  }

  private async loadFromDatabase(
    assetId: string,
    stale: CacheSlot | undefined,
  ): Promise<CacheSlot['entry']> {
    try {
      const asset = await this.prisma.asset.findFirst({
        where: { id: assetId, isActive: true },
        select: {
          id: true,
          symbol: true,
          name: true,
          assetType: true,
          market: true,
          currencyCode: true,
          priceCurrency: true,
        },
      });
      const entry = asset
        ? {
            assetId: asset.id,
            symbol: asset.symbol,
            name: asset.name,
            assetType: asset.assetType,
            market: asset.market,
            priceCurrency: asset.priceCurrency ?? asset.currencyCode,
          }
        : null;
      this.cache.set(assetId, {
        entry,
        expiresAt: Date.now() + (entry ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
      });
      return entry;
    } catch (error) {
      // A metadata read failure must never take the provider stream down.
      // Serve the stale entry when one exists; retry soon either way.
      this.logger.warn(
        `Realtime asset metadata lookup failed for ${assetId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const fallback = stale?.entry ?? null;
      this.cache.set(assetId, {
        entry: fallback,
        expiresAt: Date.now() + NEGATIVE_TTL_MS,
      });
      return fallback;
    }
  }

  private withDisplayDecimals(
    entry: CacheSlot['entry'],
  ): RealtimeAssetMetadata | null {
    if (!entry) return null;
    return {
      ...entry,
      // Resolved on every read (cheap Map lookup) so a Binance exchangeInfo
      // precision refresh reaches realtime payloads without a cache flush.
      displayPriceDecimals:
        this.binanceSymbolMetadata?.getDisplayPriceDecimals({
          market: entry.market,
          symbol: entry.symbol,
        }) ?? null,
    };
  }
}
