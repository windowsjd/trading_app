import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { BinancePublicClient } from './binance/binance-public.client';
import { BinancePriceIngestionService } from './binance/binance-price.ingestion.service';
import { BinanceRealtimePriceCacheService } from './binance/binance-realtime-price-cache.service';
import { BinanceRealtimePriceEventBus } from './binance/binance-realtime-price-event-bus.service';
import { BinanceWebSocketIngestionService } from './binance/binance-websocket.ingestion.service';
import { BinanceWebSocketStreamingService } from './binance/binance-websocket-streaming.service';
import { ExchangeRateClient } from './exchange-rate/exchange-rate.client';
import { ExchangeRateIngestionService } from './exchange-rate/exchange-rate.ingestion.service';
import { KoreaEximExchangeClient } from './korea-exim/korea-exim-exchange.client';
import { KoreaEximExchangeIngestionService } from './korea-exim/korea-exim-exchange.ingestion.service';
import { KisAuthClient } from './kis/kis-auth.client';
import { KisQuoteClient } from './kis/kis-quote.client';
import { KisRealtimePriceCacheService } from './kis/kis-realtime-price-cache.service';
import { KisRealtimePriceEventBus } from './kis/kis-realtime-price-event-bus.service';
import { KisRestCurrentPriceIngestionService } from './kis/kis-rest-current-price.ingestion.service';
import { KisRestHogaIngestionService } from './kis/kis-rest-hoga.ingestion.service';
import { KisWebSocketClient } from './kis/kis-websocket.client';
import { KisWebSocketIngestionService } from './kis/kis-websocket.ingestion.service';
import { KisWebSocketStreamingService } from './kis/kis-websocket-streaming.service';
import { readKisRateLimitConfig } from './kis/coordination/kis-rate-limit.config';
import { KisRateLimiterService } from './kis/coordination/kis-rate-limiter.service';
import { KisRequestCoordinatorService } from './kis/coordination/kis-request-coordinator.service';
import { MarketSnapshotHealthService } from './market-snapshot-health.service';
import { ProviderConfigService } from './provider-config.service';
import { ProviderHttpClient } from './provider-http.client';
import { ProviderTargetResolverService } from './provider-target-resolver.service';
import { KisCandleNormalizerService } from './kis/candles/kis-candle-normalizer.service';
import { KisDomesticFiveMinuteBuilder } from './kis/candles/kis-domestic-five-minute.builder';
import { KisDomesticMinuteAdapter } from './kis/candles/kis-domestic-minute.adapter';
import { KisUsMinuteAdapter } from './kis/candles/kis-us-minute.adapter';
import { KisDomesticPeriodAdapter } from './kis/candles/kis-domestic-period.adapter';
import { KisOverseasPeriodAdapter } from './kis/candles/kis-overseas-period.adapter';
import { KisPeriodCandleNormalizerService } from './kis/candles/kis-period-candle-normalizer.service';
import { BinanceCandleIngestionService } from './binance/binance-candle.ingestion.service';
import { NormalizedProviderTradeEventBus } from './normalized-provider-trade-event-bus.service';
import { ProviderTradeReadinessPublisher } from './provider-trade-readiness.publisher';
import { ProviderTradeReadinessStore } from './provider-trade-readiness.store';
import { ProviderTradeRouteRegistry } from './provider-trade-route.registry';

@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    ProviderConfigService,
    ProviderHttpClient,
    ExchangeRateClient,
    ExchangeRateIngestionService,
    KoreaEximExchangeClient,
    KoreaEximExchangeIngestionService,
    BinancePublicClient,
    BinancePriceIngestionService,
    BinanceRealtimePriceCacheService,
    BinanceRealtimePriceEventBus,
    BinanceWebSocketIngestionService,
    BinanceWebSocketStreamingService,
    {
      provide: KisRateLimiterService,
      useFactory: (
        redis: RedisService,
        providerConfig: ProviderConfigService,
      ) =>
        new KisRateLimiterService(
          redis,
          readKisRateLimitConfig(process.env, {
            kisEnabled: providerConfig.getKisConfig().enabled,
          }),
        ),
      inject: [RedisService, ProviderConfigService],
    },
    {
      provide: KisRequestCoordinatorService,
      useFactory: (limiter: KisRateLimiterService) =>
        new KisRequestCoordinatorService(limiter),
      inject: [KisRateLimiterService],
    },
    KisAuthClient,
    KisQuoteClient,
    KisCandleNormalizerService,
    KisDomesticFiveMinuteBuilder,
    KisDomesticMinuteAdapter,
    KisUsMinuteAdapter,
    KisDomesticPeriodAdapter,
    KisOverseasPeriodAdapter,
    KisPeriodCandleNormalizerService,
    BinanceCandleIngestionService,
    KisRestCurrentPriceIngestionService,
    KisRestHogaIngestionService,
    KisRealtimePriceCacheService,
    KisRealtimePriceEventBus,
    KisWebSocketIngestionService,
    KisWebSocketClient,
    KisWebSocketStreamingService,
    ProviderTargetResolverService,
    MarketSnapshotHealthService,
    NormalizedProviderTradeEventBus,
    ProviderTradeRouteRegistry,
    ProviderTradeReadinessStore,
    ProviderTradeReadinessPublisher,
  ],
  exports: [
    ProviderConfigService,
    ExchangeRateIngestionService,
    KoreaEximExchangeClient,
    KoreaEximExchangeIngestionService,
    BinancePublicClient,
    BinancePriceIngestionService,
    BinanceRealtimePriceCacheService,
    BinanceRealtimePriceEventBus,
    BinanceWebSocketIngestionService,
    BinanceWebSocketStreamingService,
    KisAuthClient,
    KisQuoteClient,
    KisCandleNormalizerService,
    KisDomesticFiveMinuteBuilder,
    KisDomesticMinuteAdapter,
    KisUsMinuteAdapter,
    KisDomesticPeriodAdapter,
    KisOverseasPeriodAdapter,
    KisPeriodCandleNormalizerService,
    BinanceCandleIngestionService,
    KisRestCurrentPriceIngestionService,
    KisRestHogaIngestionService,
    KisRealtimePriceCacheService,
    KisRealtimePriceEventBus,
    KisWebSocketIngestionService,
    KisWebSocketClient,
    KisWebSocketStreamingService,
    KisRateLimiterService,
    KisRequestCoordinatorService,
    ProviderTargetResolverService,
    MarketSnapshotHealthService,
    NormalizedProviderTradeEventBus,
    ProviderTradeRouteRegistry,
    ProviderTradeReadinessStore,
    ProviderTradeReadinessPublisher,
  ],
})
export class ProvidersModule {}
