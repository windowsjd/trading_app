import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AssetsModule } from '../assets/assets.module';
import { ProvidersModule } from '../providers/providers.module';
import { RedisModule } from '../redis/redis.module';
import { AssetTickerGateway } from './asset-ticker.gateway';
import { RealtimeAssetMetadataCacheService } from './realtime-asset-metadata-cache.service';
import { TICKER_FANOUT_METRICS } from './ticker-fanout-metrics';
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
    RealtimeAssetMetadataCacheService,
    LiveCandlePubSubService,
    ProviderPricePubSubService,
    LiveCandleStreamSupervisorService,
    {
      provide: LIVE_CANDLE_SOCKET_FACTORY,
      useValue: defaultLiveCandleSocketFactory,
    },
    // Readiness consumes the counters through this token, never the gateway
    // class, so it stays free of the realtime module's import graph.
    { provide: TICKER_FANOUT_METRICS, useExisting: AssetTickerGateway },
  ],
  exports: [
    AssetTickerGateway,
    TICKER_FANOUT_METRICS,
    LiveCandlePubSubService,
    ProviderPricePubSubService,
    LiveCandleStreamSupervisorService,
  ],
})
export class RealtimeModule {}
