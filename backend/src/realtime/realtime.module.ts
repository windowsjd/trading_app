import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AssetTickerGateway } from './asset-ticker.gateway';

@Module({
  imports: [JwtModule.register({})],
  providers: [AssetTickerGateway],
})
export class RealtimeModule {}
