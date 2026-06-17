import { Injectable } from '@nestjs/common';
import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpClient } from '../provider-http.client';
import { ProviderConfigError } from '../provider.types';
import type { ExchangeRateApiLatestUsdResponse } from './exchange-rate.types';

@Injectable()
export class ExchangeRateClient {
  constructor(
    private readonly configService: ProviderConfigService,
    private readonly httpClient: ProviderHttpClient,
  ) {}

  async fetchLatestUsd(): Promise<{
    response: ExchangeRateApiLatestUsdResponse;
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

    if (!config.exchangeRateApi.enabled) {
      throw new ProviderConfigError(
        'exchange_rate_api',
        'PROVIDER_DISABLED',
        'ExchangeRate-API provider is disabled.',
      );
    }

    const apiKey = config.exchangeRateApi.apiKey;
    if (!apiKey) {
      throw new ProviderConfigError(
        'exchange_rate_api',
        'REQUIRED_ENV_MISSING',
        'EXCHANGE_RATE_API_KEY is required.',
      );
    }

    const baseUrl = config.exchangeRateApi.baseUrl.replace(/\/+$/u, '');
    const url = `${baseUrl}/${encodeURIComponent(apiKey)}/latest/USD`;
    const result =
      await this.httpClient.getJson<ExchangeRateApiLatestUsdResponse>(url, {
        provider: 'exchange_rate_api',
        timeoutMs: config.common.httpTimeoutMs,
        secrets: [apiKey],
      });

    return {
      response: result.json,
      receivedAt: result.receivedAt,
    };
  }
}
