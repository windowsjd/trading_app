import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AssetType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { MarketCalendarMarket } from '../orders/market-calendar/market-calendar.types';
import { MarketSessionOverrideLoaderService } from '../orders/market-calendar/market-session-override.loader.service';
import { AssetCandlesCacheService } from './asset-candles-cache.service';

/**
 * Bumps the per-asset candle-cache generation whenever the operator
 * market-session override snapshot changes for a market, so cached candle
 * responses computed under the old schedule become unreachable. Every
 * instance invalidates on its own snapshot change (mutation-local refresh or
 * bounded polling); the generation INCR is shared via Redis, so repeated
 * bumps are harmless. Crypto assets are never touched.
 */
@Injectable()
export class MarketSessionOverrideCacheInvalidatorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    MarketSessionOverrideCacheInvalidatorService.name,
  );
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly overrideLoader: MarketSessionOverrideLoaderService,
    private readonly cache: AssetCandlesCacheService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.overrideLoader.onOverridesChanged((markets) => {
      void this.invalidateMarkets(markets).catch(() => undefined);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async invalidateMarkets(
    markets: readonly MarketCalendarMarket[],
  ): Promise<void> {
    const assetTypes = markets.map((market) =>
      market === 'KRX' ? AssetType.domestic_stock : AssetType.us_stock,
    );
    if (assetTypes.length === 0) return;

    try {
      const assets = await this.prisma.asset.findMany({
        where: { assetType: { in: assetTypes } },
        select: { id: true },
      });
      for (const asset of assets) {
        await this.cache.invalidateAsset(asset.id);
      }
      this.logger.log(
        JSON.stringify({
          event: 'market_session_override_candle_cache_invalidated',
          markets,
          assetCount: assets.length,
        }),
      );
    } catch (error) {
      // Cache entries still expire by their bounded TTLs; the invalidation is
      // an optimization for prompt convergence, not a correctness gate for
      // the DB-backed candle data itself.
      this.logger.warn(
        JSON.stringify({
          event: 'market_session_override_candle_cache_invalidation_failed',
          markets,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
