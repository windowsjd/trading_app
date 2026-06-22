import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AssetsModule } from '../assets/assets.module';
import { AssetTickerGateway } from './asset-ticker.gateway';

@Module({
  imports: [AssetsModule, JwtModule.register({})],
  providers: [AssetTickerGateway],
})
export class RealtimeModule {}
