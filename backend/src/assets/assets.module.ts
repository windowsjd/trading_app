import { Logger, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { RedisLockService } from '../redis/redis-lock.service';
import { ProvidersModule } from '../providers/providers.module';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import { AssetCandlesService } from './asset-candles.service';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { MarketCandlesRepository } from './market-candles.repository';
import { AssetCandlesSingleFlightService } from './asset-candles-single-flight.service';
import { readCandleSingleFlightConfig } from './asset-candles-single-flight.config';
import { MarketCandleRetentionService } from './market-candle-retention.service';
import { MarketCandleIngestionService } from './market-candle-ingestion.service';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import { MarketCandleBackfillLockService } from './market-candle-backfill-lock.service';
import { MarketCandleSyncStateRepository } from './market-candle-sync-state.repository';
import { MarketCandleSyncService } from './market-candle-sync.service';
import {
  MARKET_CANDLE_SYNC_CONFIG,
  readMarketCandleSyncConfig,
} from './market-candle-sync.config';
import {
  CANDLE_SERVING_CONFIG,
  readCandleServingConfig,
} from './candle-serving.config';
import { CandleReadPlanBuilder } from './candle-read-plan.builder';
import { CandleResponseBuilder } from './candle-response.builder';
import { CandleDatabaseLoader } from './candle-database.loader';
import { CandleServingService } from './candle-serving.service';
import {
  LIVE_CANDLE_CONFIG,
  readLiveCandleConfig,
  validateLiveReconciliationDependencies,
} from './live-candle.config';
import { LiveCandleHealthService } from './live-candle-health.service';
import { LiveCandleEventNormalizerService } from './live-candle-event-normalizer.service';
import { LiveCandleStoreService } from './live-candle-store.service';
import { LiveCandleHydratorService } from './live-candle-hydrator.service';
import { LiveCandleOverlayService } from './live-candle-overlay.service';
import { LiveCandlePublisherService } from './live-candle-publisher.service';
import { LiveCandlePipelineService } from './live-candle-pipeline.service';
import { LiveCandleFinalizerService } from './live-candle-finalizer.service';
import {
  MARKET_CANDLE_RECONCILIATION_CONFIG,
  readMarketCandleReconciliationConfig,
} from './market-candle-reconciliation.config';
import { MarketCandleReconciliationService } from './market-candle-reconciliation.service';

// AssetCandlesCacheService is provided (via factory so Nest supplies its default
// env-derived config) and exported for a later serving step to inject. It is
// intentionally NOT injected into AssetCandlesService yet: the provider call
// flow and the candles endpoint are unchanged in this step.
@Module({
  imports: [ProvidersModule, RedisModule],
  controllers: [AssetsController],
  providers: [
    AssetsService,
    AssetCandlesService,
    MarketCandlesRepository,
    {
      provide: MarketCandleRetentionService,
      useFactory: (repository: MarketCandlesRepository) =>
        new MarketCandleRetentionService(repository),
      inject: [MarketCandlesRepository],
    },
    MarketCandleIngestionService,
    MarketCandleAggregationService,
    MarketCandleBackfillLockService,
    MarketCandleSyncStateRepository,
    MarketCandleSyncService,
    CandleReadPlanBuilder,
    CandleResponseBuilder,
    CandleDatabaseLoader,
    CandleServingService,
    LiveCandleHealthService,
    LiveCandleEventNormalizerService,
    LiveCandleStoreService,
    LiveCandleHydratorService,
    LiveCandleOverlayService,
    LiveCandlePublisherService,
    LiveCandlePipelineService,
    LiveCandleFinalizerService,
    MarketCandleReconciliationService,
    {
      provide: LIVE_CANDLE_CONFIG,
      useFactory: () => {
        const live = readLiveCandleConfig();
        // Refuses invalid live/reconciliation combinations in production;
        // returns warnings elsewhere.
        const warnings = validateLiveReconciliationDependencies({
          live,
          reconciliation: readMarketCandleReconciliationConfig(),
          nodeEnv: process.env.NODE_ENV,
        });
        for (const warning of warnings) {
          new Logger('LiveCandleConfig').warn(warning);
        }
        return live;
      },
    },
    {
      provide: MARKET_CANDLE_RECONCILIATION_CONFIG,
      useFactory: () => readMarketCandleReconciliationConfig(),
    },
    {
      provide: CANDLE_SERVING_CONFIG,
      useFactory: () => readCandleServingConfig(),
    },
    {
      provide: MARKET_CANDLE_SYNC_CONFIG,
      useFactory: () => readMarketCandleSyncConfig(),
    },
    {
      provide: AssetCandlesCacheService,
      useFactory: (redis: RedisService) => new AssetCandlesCacheService(redis),
      inject: [RedisService],
    },
    {
      provide: AssetCandlesSingleFlightService,
      useFactory: (cache: AssetCandlesCacheService, locks: RedisLockService) =>
        new AssetCandlesSingleFlightService(
          cache,
          locks,
          readCandleSingleFlightConfig(),
        ),
      inject: [AssetCandlesCacheService, RedisLockService],
    },
  ],
  exports: [
    AssetsService,
    MarketCandlesRepository,
    MarketCandleRetentionService,
    MarketCandleIngestionService,
    MarketCandleAggregationService,
    MarketCandleBackfillLockService,
    MarketCandleSyncStateRepository,
    MarketCandleSyncService,
    AssetCandlesCacheService,
    AssetCandlesSingleFlightService,
    LIVE_CANDLE_CONFIG,
    LiveCandleHealthService,
    LiveCandleEventNormalizerService,
    LiveCandleStoreService,
    LiveCandleOverlayService,
    LiveCandlePublisherService,
    LiveCandlePipelineService,
    MARKET_CANDLE_RECONCILIATION_CONFIG,
    MarketCandleReconciliationService,
  ],
})
export class AssetsModule {}
