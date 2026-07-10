import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { AssetCandlesService } from './asset-candles.service';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { MarketCandlesRepository } from './market-candles.repository';

@Module({
  imports: [ProvidersModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetCandlesService, MarketCandlesRepository],
  exports: [AssetsService, MarketCandlesRepository],
})
export class AssetsModule {}
