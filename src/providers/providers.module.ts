import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BinancePublicClient } from './binance/binance-public.client';
import { BinancePriceIngestionService } from './binance/binance-price.ingestion.service';
import { ExchangeRateClient } from './exchange-rate/exchange-rate.client';
import { ExchangeRateIngestionService } from './exchange-rate/exchange-rate.ingestion.service';
import { KisAuthClient } from './kis/kis-auth.client';
import { KisQuoteClient } from './kis/kis-quote.client';
import { KisWebSocketClient } from './kis/kis-websocket.client';
import { KisWebSocketIngestionService } from './kis/kis-websocket.ingestion.service';
import { ProviderConfigService } from './provider-config.service';
import { ProviderHttpClient } from './provider-http.client';

@Module({
  imports: [PrismaModule],
  providers: [
    ProviderConfigService,
    ProviderHttpClient,
    ExchangeRateClient,
    ExchangeRateIngestionService,
    BinancePublicClient,
    BinancePriceIngestionService,
    KisAuthClient,
    KisQuoteClient,
    KisWebSocketIngestionService,
    KisWebSocketClient,
  ],
  exports: [
    ProviderConfigService,
    ExchangeRateIngestionService,
    BinancePriceIngestionService,
    KisAuthClient,
    KisQuoteClient,
    KisWebSocketIngestionService,
    KisWebSocketClient,
  ],
})
export class ProvidersModule {}
