import { Injectable } from '@nestjs/common';
import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpClient } from '../provider-http.client';
import { ProviderConfigError } from '../provider.types';
import type {
  BinanceKlinesResponse,
  BinanceTicker24hrResponse,
} from './binance.types';

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

  async fetchKlines(input: {
    symbol: string;
    interval: string;
    limit: number;
    startTime?: number;
    endTime?: number;
  }): Promise<{
    response: BinanceKlinesResponse;
    receivedAt: Date;
  }> {
    const config = this.configService.getConfig();
    if (!config.binance.enabled) {
      throw new ProviderConfigError(
        'binance',
        'PROVIDER_DISABLED',
        'Binance public market data provider is disabled.',
      );
    }

    const baseUrl = config.binance.restBaseUrl.replace(/\/+$/u, '');
    const url = new URL(`${baseUrl}/api/v3/klines`);
    url.searchParams.set('symbol', input.symbol.trim().toUpperCase());
    url.searchParams.set('interval', input.interval);
    url.searchParams.set('limit', String(input.limit));

    if (input.startTime !== undefined) {
      url.searchParams.set('startTime', String(input.startTime));
    }

    if (input.endTime !== undefined) {
      url.searchParams.set('endTime', String(input.endTime));
    }

    const result = await this.httpClient.getJson<BinanceKlinesResponse>(
      url.toString(),
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
