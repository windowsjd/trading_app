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
import {
  KIS_FIXED_DOMESTIC_SYMBOLS,
  KIS_FIXED_US_SYMBOLS,
} from './kis/kis-fixed-asset-universe';

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

export type KoreaEximExchangeConfig = {
  enabled: boolean;
  authKey?: string;
  baseUrl: string;
  data: string;
  lookbackDays: number;
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
  restDomesticCurrentPricePath: string;
  restDomesticCurrentPriceTrId: string;
  restUsCurrentPricePath: string;
  restUsCurrentPriceTrId: string;
  restDomesticHogaPath: string;
  restDomesticHogaTrId: string;
  restUsHogaPath: string;
  restUsHogaTrId: string;
  wsBaseUrl?: string;
  wsCustType: string;
  wsDomesticTrId: string;
  wsOverseasDelayedTrId: string;
  wsSnapshotThrottleMs: number;
  wsMaxRuntimeMs: number;
  wsAllowUsDelayed: boolean;
  wsStreamingEnabled: boolean;
  wsStreamingReconnectMinMs: number;
  wsStreamingReconnectMaxMs: number;
  wsStreamingHeartbeatTimeoutMs: number;
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
  koreaEximExchange: KoreaEximExchangeConfig;
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

  getKoreaEximExchangeConfig(
    env: ProviderEnv = process.env,
  ): KoreaEximExchangeConfig {
    return buildProviderConfig(env).koreaEximExchange;
  }

  getBinanceConfig(
    env: ProviderEnv = process.env,
  ): BinancePublicMarketDataConfig {
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

  const koreaEximExchangeEnabled = readBooleanEnv(
    env,
    'KOREA_EXIM_EXCHANGE_ENABLED',
    false,
    'korea_exim_exchange_rate',
  );
  const koreaEximExchangeBaseUrl = readOptionalTrimmedEnv(
    env,
    'KOREA_EXIM_EXCHANGE_BASE_URL',
  );
  const koreaEximExchange: KoreaEximExchangeConfig = {
    enabled: koreaEximExchangeEnabled,
    authKey: koreaEximExchangeEnabled
      ? readRequiredKoreaEximAuthKey(env)
      : readOptionalTrimmedEnv(env, 'KOREA_EXIM_EXCHANGE_AUTH_KEY'),
    baseUrl: koreaEximExchangeBaseUrl ?? 'https://oapi.koreaexim.go.kr',
    data: readOptionalTrimmedEnv(env, 'KOREA_EXIM_EXCHANGE_DATA') ?? 'AP01',
    lookbackDays: readPositiveIntegerEnv(
      env,
      'KOREA_EXIM_EXCHANGE_LOOKBACK_DAYS',
      7,
      'korea_exim_exchange_rate',
    ),
  };

  if (
    koreaEximExchangeEnabled &&
    env.KOREA_EXIM_EXCHANGE_BASE_URL !== undefined &&
    koreaEximExchangeBaseUrl === undefined
  ) {
    throw new ProviderConfigError(
      'korea_exim_exchange_rate',
      'REQUIRED_ENV_MISSING',
      'KOREA_EXIM_EXCHANGE_BASE_URL is required when korea_exim_exchange_rate is enabled.',
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
    symbols:
      binanceSymbols.length > 0 ? binanceSymbols : ['BTCUSDT', 'ETHUSDT'],
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
  const envDomesticSymbols = readCsvEnv(env, 'KIS_DOMESTIC_SYMBOLS');
  const envUsSymbols = readCsvEnv(env, 'KIS_US_SYMBOLS');
  const watchlist = buildKisWatchlist({
    domesticSymbols:
      envDomesticSymbols.length > 0
        ? envDomesticSymbols
        : KIS_FIXED_DOMESTIC_SYMBOLS,
    usSymbols: envUsSymbols.length > 0 ? envUsSymbols : KIS_FIXED_US_SYMBOLS,
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
    restDomesticCurrentPricePath:
      readOptionalTrimmedEnv(env, 'KIS_REST_DOMESTIC_CURRENT_PRICE_PATH') ??
      '/uapi/domestic-stock/v1/quotations/inquire-price',
    restDomesticCurrentPriceTrId:
      readOptionalTrimmedEnv(env, 'KIS_REST_DOMESTIC_CURRENT_PRICE_TR_ID') ??
      'FHKST01010100',
    restUsCurrentPricePath:
      readOptionalTrimmedEnv(env, 'KIS_REST_US_CURRENT_PRICE_PATH') ??
      '/uapi/overseas-price/v1/quotations/price',
    restUsCurrentPriceTrId:
      readOptionalTrimmedEnv(env, 'KIS_REST_US_CURRENT_PRICE_TR_ID') ??
      'HHDFS00000300',
    restDomesticHogaPath:
      readOptionalTrimmedEnv(env, 'KIS_REST_DOMESTIC_HOGA_PATH') ??
      '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
    restDomesticHogaTrId:
      readOptionalTrimmedEnv(env, 'KIS_REST_DOMESTIC_HOGA_TR_ID') ??
      'FHKST01010200',
    restUsHogaPath:
      readOptionalTrimmedEnv(env, 'KIS_REST_US_HOGA_PATH') ??
      '/uapi/overseas-price/v1/quotations/inquire-asking-price',
    restUsHogaTrId:
      readOptionalTrimmedEnv(env, 'KIS_REST_US_HOGA_TR_ID') ?? 'HHDFS76200100',
    wsBaseUrl: kisWsBaseUrl,
    wsCustType: readOptionalTrimmedEnv(env, 'KIS_WS_CUSTTYPE') ?? 'P',
    wsDomesticTrId:
      readOptionalTrimmedEnv(env, 'KIS_WS_DOMESTIC_TR_ID') ?? 'H0STCNT0',
    wsOverseasDelayedTrId:
      readOptionalTrimmedEnv(env, 'KIS_WS_OVERSEAS_DELAYED_TR_ID') ??
      'HDFSCNT0',
    wsSnapshotThrottleMs: readPositiveIntegerEnv(
      env,
      'KIS_WS_SNAPSHOT_THROTTLE_MS',
      5000,
      'kis',
    ),
    wsMaxRuntimeMs: readPositiveIntegerEnv(
      env,
      'KIS_WS_MAX_RUNTIME_MS',
      30000,
      'kis',
    ),
    wsAllowUsDelayed: readBooleanEnv(
      env,
      'KIS_WS_ALLOW_US_DELAYED',
      true,
      'kis',
    ),
    wsStreamingEnabled: readBooleanEnv(
      env,
      'KIS_WEBSOCKET_STREAMING_ENABLED',
      false,
      'kis',
    ),
    wsStreamingReconnectMinMs: readPositiveIntegerEnv(
      env,
      'KIS_WEBSOCKET_STREAMING_RECONNECT_MIN_MS',
      1000,
      'kis',
    ),
    wsStreamingReconnectMaxMs: readPositiveIntegerEnv(
      env,
      'KIS_WEBSOCKET_STREAMING_RECONNECT_MAX_MS',
      30000,
      'kis',
    ),
    wsStreamingHeartbeatTimeoutMs: readPositiveIntegerEnv(
      env,
      'KIS_WEBSOCKET_STREAMING_HEARTBEAT_TIMEOUT_MS',
      60000,
      'kis',
    ),
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
    koreaEximExchange,
    binance,
    kis,
  };
}

function readRequiredKoreaEximAuthKey(env: ProviderEnv): string {
  const value = readOptionalTrimmedEnv(env, 'KOREA_EXIM_EXCHANGE_AUTH_KEY');
  if (value === undefined) {
    throw new ProviderConfigError(
      'korea_exim_exchange_rate',
      'KOREA_EXIM_AUTH_KEY_MISSING',
      'KOREA_EXIM_EXCHANGE_AUTH_KEY is required when korea_exim_exchange_rate is enabled.',
    );
  }

  return value;
}
