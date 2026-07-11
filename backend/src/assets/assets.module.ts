import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { ProvidersModule } from '../providers/providers.module';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import { AssetCandlesService } from './asset-candles.service';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { MarketCandlesRepository } from './market-candles.repository';

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
      provide: AssetCandlesCacheService,
      useFactory: (redis: RedisService) => new AssetCandlesCacheService(redis),
      inject: [RedisService],
    },
  ],
  exports: [AssetsService, MarketCandlesRepository, AssetCandlesCacheService],
})
export class AssetsModule {}
