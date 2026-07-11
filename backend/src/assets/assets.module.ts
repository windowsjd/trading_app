import { Module } from '@nestjs/common';
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
    MarketCandleRetentionService,
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
    AssetCandlesCacheService,
    AssetCandlesSingleFlightService,
  ],
})
export class AssetsModule {}
