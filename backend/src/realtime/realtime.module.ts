import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AssetsModule } from '../assets/assets.module';
import { ProvidersModule } from '../providers/providers.module';
import { RedisModule } from '../redis/redis.module';
import { AssetTickerGateway } from './asset-ticker.gateway';
import { LiveCandlePubSubService } from './live-candle-pubsub.service';
import { ProviderPricePubSubService } from './provider-price-pubsub.service';
import {
  defaultLiveCandleSocketFactory,
  LIVE_CANDLE_SOCKET_FACTORY,
  LiveCandleStreamSupervisorService,
} from './live-candle-stream-supervisor.service';

@Module({
  imports: [AssetsModule, ProvidersModule, RedisModule, JwtModule.register({})],
  providers: [
    AssetTickerGateway,
    LiveCandlePubSubService,
    ProviderPricePubSubService,
    LiveCandleStreamSupervisorService,
    {
      provide: LIVE_CANDLE_SOCKET_FACTORY,
      useValue: defaultLiveCandleSocketFactory,
    },
  ],
  exports: [
    LiveCandlePubSubService,
    ProviderPricePubSubService,
    LiveCandleStreamSupervisorService,
  ],
})
export class RealtimeModule {}
