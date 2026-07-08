import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BinancePublicClient } from './binance/binance-public.client';
import { BinancePriceIngestionService } from './binance/binance-price.ingestion.service';
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
import { MarketSnapshotHealthService } from './market-snapshot-health.service';
import { ProviderConfigService } from './provider-config.service';
import { ProviderHttpClient } from './provider-http.client';
import { ProviderTargetResolverService } from './provider-target-resolver.service';

@Module({
  imports: [PrismaModule],
  providers: [
    ProviderConfigService,
    ProviderHttpClient,
    ExchangeRateClient,
    ExchangeRateIngestionService,
    KoreaEximExchangeClient,
    KoreaEximExchangeIngestionService,
    BinancePublicClient,
    BinancePriceIngestionService,
    KisAuthClient,
    KisQuoteClient,
    KisRestCurrentPriceIngestionService,
    KisRestHogaIngestionService,
    KisRealtimePriceCacheService,
    KisRealtimePriceEventBus,
    KisWebSocketIngestionService,
    KisWebSocketClient,
    KisWebSocketStreamingService,
    ProviderTargetResolverService,
    MarketSnapshotHealthService,
  ],
  exports: [
    ProviderConfigService,
    ExchangeRateIngestionService,
    KoreaEximExchangeClient,
    KoreaEximExchangeIngestionService,
    BinancePublicClient,
    BinancePriceIngestionService,
    KisAuthClient,
    KisQuoteClient,
    KisRestCurrentPriceIngestionService,
    KisRestHogaIngestionService,
    KisRealtimePriceCacheService,
    KisRealtimePriceEventBus,
    KisWebSocketIngestionService,
    KisWebSocketClient,
    KisWebSocketStreamingService,
    ProviderTargetResolverService,
    MarketSnapshotHealthService,
  ],
})
export class ProvidersModule {}
