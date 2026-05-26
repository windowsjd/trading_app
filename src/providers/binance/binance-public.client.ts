import { Injectable } from '@nestjs/common';
import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpClient } from '../provider-http.client';
import { ProviderConfigError } from '../provider.types';
import type { BinanceTicker24hrResponse } from './binance.types';

@Injectable()
export class BinancePublicClient {
  constructor(
    private readonly configService: ProviderConfigService,
    private readonly httpClient: ProviderHttpClient,
  ) {}

  async fetchTicker24hr(symbol: string): Promise<{
    response: BinanceTicker24hrResponse;
    receivedAt: Date;
  }> {
    const config = this.configService.getConfig();
    if (!config.common.providerIngestionEnabled) {
      throw new ProviderConfigError(
        'common',
        'PROVIDER_INGESTION_DISABLED',
        'Provider ingestion is disabled.',
      );
    }

    if (!config.binance.enabled) {
      throw new ProviderConfigError(
        'binance',
        'PROVIDER_DISABLED',
        'Binance public market data provider is disabled.',
      );
    }

    const baseUrl = config.binance.restBaseUrl.replace(/\/+$/u, '');
    const normalizedSymbol = symbol.trim().toUpperCase();
    const url = `${baseUrl}/api/v3/ticker/24hr?symbol=${encodeURIComponent(
      normalizedSymbol,
    )}`;
    const result = await this.httpClient.getJson<BinanceTicker24hrResponse>(
      url,
      {
        provider: 'binance',
        timeoutMs: config.common.httpTimeoutMs,
      },
    );

    return {
      response: result.json,
      receivedAt: result.receivedAt,
    };
  }
}
