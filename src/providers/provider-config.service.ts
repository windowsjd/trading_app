import { Injectable } from '@nestjs/common';
import {
  normalizeUppercaseCsv,
  readBooleanEnv,
  readCsvEnv,
  readOptionalTrimmedEnv,
  readPositiveIntegerEnv,
  requireEnv,
  type ProviderEnv,
} from './provider-env.validation';
import { ProviderConfigError } from './provider.types';
import { buildKisWatchlist } from './kis/kis-watchlist.policy';

export type CommonProviderConfig = {
  providerIngestionEnabled: boolean;
  httpTimeoutMs: number;
  rawPayloadMaxBytes: number;
};

export type ExchangeRateApiConfig = {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
};

export type BinancePublicMarketDataConfig = {
  enabled: boolean;
  restBaseUrl: string;
  wsMarketDataBaseUrl: string;
  symbols: string[];
  usdtAsUsdEquivalent: boolean;
};

export type KisMarketDataConfig = {
  enabled: boolean;
  appKey?: string;
  appSecret?: string;
  restBaseUrl?: string;
  wsBaseUrl?: string;
  maxWatchlistSize: number;
  domesticSymbols: string[];
  usSymbols: string[];
  allSymbols: string[];
  canCallRestLive: boolean;
  canCallWebSocketLive: boolean;
};

export type ProviderConfig = {
  common: CommonProviderConfig;
  exchangeRateApi: ExchangeRateApiConfig;
  binance: BinancePublicMarketDataConfig;
  kis: KisMarketDataConfig;
};

@Injectable()
export class ProviderConfigService {
  getConfig(env: ProviderEnv = process.env): ProviderConfig {
    return buildProviderConfig(env);
  }

  getCommonConfig(env: ProviderEnv = process.env): CommonProviderConfig {
    return buildProviderConfig(env).common;
  }

  getExchangeRateApiConfig(
    env: ProviderEnv = process.env,
  ): ExchangeRateApiConfig {
    return buildProviderConfig(env).exchangeRateApi;
  }

  getBinanceConfig(env: ProviderEnv = process.env): BinancePublicMarketDataConfig {
    return buildProviderConfig(env).binance;
  }

  getKisConfig(env: ProviderEnv = process.env): KisMarketDataConfig {
    return buildProviderConfig(env).kis;
  }
}

export function buildProviderConfig(env: ProviderEnv): ProviderConfig {
  const common: CommonProviderConfig = {
    providerIngestionEnabled: readBooleanEnv(
      env,
      'PROVIDER_INGESTION_ENABLED',
      false,
      'common',
    ),
    httpTimeoutMs: readPositiveIntegerEnv(
      env,
      'PROVIDER_HTTP_TIMEOUT_MS',
      5000,
      'common',
    ),
    rawPayloadMaxBytes: readPositiveIntegerEnv(
      env,
      'PROVIDER_RAW_PAYLOAD_MAX_BYTES',
      12000,
      'common',
    ),
  };

  const exchangeRateEnabled = readBooleanEnv(
    env,
    'EXCHANGE_RATE_API_ENABLED',
    false,
    'exchange_rate_api',
  );
  const exchangeRateApi: ExchangeRateApiConfig = {
    enabled: exchangeRateEnabled,
    apiKey: exchangeRateEnabled
      ? requireEnv(env, 'EXCHANGE_RATE_API_KEY', 'exchange_rate_api')
      : readOptionalTrimmedEnv(env, 'EXCHANGE_RATE_API_KEY'),
    baseUrl:
      readOptionalTrimmedEnv(env, 'EXCHANGE_RATE_API_BASE_URL') ??
      'https://v6.exchangerate-api.com/v6',
  };

  if (exchangeRateEnabled && !exchangeRateApi.baseUrl) {
    throw new ProviderConfigError(
      'exchange_rate_api',
      'REQUIRED_ENV_MISSING',
      'EXCHANGE_RATE_API_BASE_URL is required when exchange_rate_api is enabled.',
    );
  }

  const binanceEnabled = readBooleanEnv(
    env,
    'BINANCE_PUBLIC_MARKET_DATA_ENABLED',
    false,
    'binance',
  );
  const binanceSymbols = normalizeUppercaseCsv(
    readCsvEnv(env, 'BINANCE_CRYPTO_SYMBOLS'),
  );
  const binance: BinancePublicMarketDataConfig = {
    enabled: binanceEnabled,
    restBaseUrl:
      readOptionalTrimmedEnv(env, 'BINANCE_REST_BASE_URL') ??
      'https://api.binance.com',
    wsMarketDataBaseUrl:
      readOptionalTrimmedEnv(env, 'BINANCE_WS_MARKET_DATA_BASE_URL') ??
      'wss://data-stream.binance.vision',
    symbols: binanceSymbols.length > 0 ? binanceSymbols : ['BTCUSDT', 'ETHUSDT'],
    usdtAsUsdEquivalent: readBooleanEnv(
      env,
      'BINANCE_CRYPTO_USDT_AS_USD_EQUIVALENT',
      true,
      'binance',
    ),
  };

  if (binance.enabled && !binance.restBaseUrl) {
    throw new ProviderConfigError(
      'binance',
      'REQUIRED_ENV_MISSING',
      'BINANCE_REST_BASE_URL is required when binance is enabled.',
    );
  }

  const kisEnabled = readBooleanEnv(
    env,
    'KIS_MARKET_DATA_ENABLED',
    false,
    'kis',
  );
  const maxWatchlistSize = readPositiveIntegerEnv(
    env,
    'KIS_MAX_WATCHLIST_SIZE',
    41,
    'kis',
  );
  const watchlist = buildKisWatchlist({
    domesticSymbols: readCsvEnv(env, 'KIS_DOMESTIC_SYMBOLS'),
    usSymbols: readCsvEnv(env, 'KIS_US_SYMBOLS'),
    maxSize: maxWatchlistSize,
  });
  const kisRestBaseUrl = readOptionalTrimmedEnv(env, 'KIS_REST_BASE_URL');
  const kisWsBaseUrl = readOptionalTrimmedEnv(env, 'KIS_WS_BASE_URL');
  const kis: KisMarketDataConfig = {
    enabled: kisEnabled,
    appKey: kisEnabled
      ? requireEnv(env, 'KIS_APP_KEY', 'kis')
      : readOptionalTrimmedEnv(env, 'KIS_APP_KEY'),
    appSecret: kisEnabled
      ? requireEnv(env, 'KIS_APP_SECRET', 'kis')
      : readOptionalTrimmedEnv(env, 'KIS_APP_SECRET'),
    restBaseUrl: kisRestBaseUrl,
    wsBaseUrl: kisWsBaseUrl,
    maxWatchlistSize,
    domesticSymbols: watchlist.domesticSymbols,
    usSymbols: watchlist.usSymbols,
    allSymbols: watchlist.allSymbols,
    canCallRestLive: kisEnabled && Boolean(kisRestBaseUrl),
    canCallWebSocketLive: kisEnabled && Boolean(kisWsBaseUrl),
  };

  return {
    common,
    exchangeRateApi,
    binance,
    kis,
  };
}
