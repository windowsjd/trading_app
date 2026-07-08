import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AssetsModule } from '../assets/assets.module';
import { ProvidersModule } from '../providers/providers.module';
import { AssetTickerGateway } from './asset-ticker.gateway';

@Module({
  imports: [AssetsModule, ProvidersModule, JwtModule.register({})],
  providers: [AssetTickerGateway],
})
export class RealtimeModule {}
