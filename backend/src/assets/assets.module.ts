import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { AssetCandlesService } from './asset-candles.service';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

@Module({
  imports: [ProvidersModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetCandlesService],
  exports: [AssetsService],
})
export class AssetsModule {}
