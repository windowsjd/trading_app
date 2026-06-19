import { Injectable } from '@nestjs/common';
import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpClient } from '../provider-http.client';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import {
  KOREA_EXIM_EXCHANGE_SOURCE_NAME,
  type KoreaEximExchangeRateRow,
} from './korea-exim-exchange.types';

const EXCHANGE_JSON_PATH = '/site/program/financial/exchangeJSON';

@Injectable()
export class KoreaEximExchangeClient {
  constructor(
    private readonly configService: ProviderConfigService,
    private readonly httpClient: ProviderHttpClient,
  ) {}

  async fetchDailyExchangeRates(input: {
    searchDate: string;
  }): Promise<{ receivedAt: Date; rows: KoreaEximExchangeRateRow[] }> {
    const config = this.configService.getConfig();
    if (!config.common.providerIngestionEnabled) {
      throw new ProviderConfigError(
        'common',
        'PROVIDER_INGESTION_DISABLED',
        'Provider ingestion is disabled.',
      );
    }

    if (!config.koreaEximExchange.enabled) {
      throw new ProviderConfigError(
        KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        'KOREA_EXIM_PROVIDER_DISABLED',
        'Korea EXIM exchange provider is disabled.',
      );
    }

    const authKey = config.koreaEximExchange.authKey;
    if (!authKey) {
      throw new ProviderConfigError(
        KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        'KOREA_EXIM_AUTH_KEY_MISSING',
        'KOREA_EXIM_EXCHANGE_AUTH_KEY is required.',
      );
    }

    const url = this.buildRequestUrl({
      baseUrl: config.koreaEximExchange.baseUrl,
      authKey,
      searchDate: input.searchDate,
      data: config.koreaEximExchange.data,
    });

    try {
      const result = await this.httpClient.getJson<unknown>(url, {
        provider: KOREA_EXIM_EXCHANGE_SOURCE_NAME,
        timeoutMs: config.common.httpTimeoutMs,
        secrets: [authKey],
      });

      if (!Array.isArray(result.json)) {
        throw new ProviderHttpError(
          KOREA_EXIM_EXCHANGE_SOURCE_NAME,
          'KOREA_EXIM_MALFORMED_RESPONSE',
          'Korea EXIM exchange API returned a non-array response.',
        );
      }

      return {
        receivedAt: result.receivedAt,
        rows: result.json as KoreaEximExchangeRateRow[],
      };
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        if (error.code === 'KOREA_EXIM_MALFORMED_RESPONSE') {
          throw error;
        }

        throw new ProviderHttpError(
          KOREA_EXIM_EXCHANGE_SOURCE_NAME,
          error.code === 'PROVIDER_JSON_PARSE_ERROR'
            ? 'KOREA_EXIM_JSON_PARSE_ERROR'
            : 'KOREA_EXIM_HTTP_ERROR',
          error.message,
        );
      }

      throw error;
    }
  }

  private buildRequestUrl(input: {
    baseUrl: string;
    authKey: string;
    searchDate: string;
    data: string;
  }): string {
    const url = new URL(EXCHANGE_JSON_PATH, input.baseUrl);
    url.searchParams.set('authkey', input.authKey);
    url.searchParams.set('searchdate', input.searchDate);
    url.searchParams.set('data', input.data);
    return url.toString();
  }
}
