import { buildProviderConfig } from './provider-config.service';
import { ProviderConfigError } from './provider.types';

describe('provider config', () => {
  it('allows all providers disabled with missing secrets', () => {
    const config = buildProviderConfig({});

    expect(config.common.providerIngestionEnabled).toBe(false);
    expect(config.exchangeRateApi.enabled).toBe(false);
    expect(config.koreaEximExchange).toMatchObject({
      enabled: false,
      baseUrl: 'https://oapi.koreaexim.go.kr',
      data: 'AP01',
      lookbackDays: 7,
    });
    expect(config.binance.enabled).toBe(false);
    expect(config.kis.enabled).toBe(false);
  });

  it('fails provider-specifically when ExchangeRate-API is enabled without its key', () => {
    expect(() =>
      buildProviderConfig({
        EXCHANGE_RATE_API_ENABLED: 'true',
      }),
    ).toThrow(ProviderConfigError);

    try {
      buildProviderConfig({
        EXCHANGE_RATE_API_ENABLED: 'true',
      });
    } catch (error) {
      expect(error).toMatchObject({
        provider: 'exchange_rate_api',
        code: 'REQUIRED_ENV_MISSING',
      });
    }
  });

  it('fails closed when Korea EXIM exchange is enabled without its auth key', () => {
    expect(() =>
      buildProviderConfig({
        KOREA_EXIM_EXCHANGE_ENABLED: 'true',
      }),
    ).toThrow(ProviderConfigError);

    try {
      buildProviderConfig({
        KOREA_EXIM_EXCHANGE_ENABLED: 'true',
      });
    } catch (error) {
      expect(error).toMatchObject({
        provider: 'korea_exim_exchange_rate',
        code: 'KOREA_EXIM_AUTH_KEY_MISSING',
      });
    }
  });

  it('parses Korea EXIM exchange env defaults and overrides', () => {
    const config = buildProviderConfig({
      KOREA_EXIM_EXCHANGE_ENABLED: 'true',
      KOREA_EXIM_EXCHANGE_AUTH_KEY: 'test-auth-key',
      KOREA_EXIM_EXCHANGE_BASE_URL: 'https://example.test',
      KOREA_EXIM_EXCHANGE_DATA: 'AP01',
      KOREA_EXIM_EXCHANGE_LOOKBACK_DAYS: '3',
    });

    expect(config.koreaEximExchange).toEqual({
      enabled: true,
      authKey: 'test-auth-key',
      baseUrl: 'https://example.test',
      data: 'AP01',
      lookbackDays: 3,
    });
  });

  it('allows KIS disabled with empty app keys and base URLs', () => {
    const config = buildProviderConfig({
      KIS_MARKET_DATA_ENABLED: 'false',
      KIS_APP_KEY: '',
      KIS_APP_SECRET: '',
      KIS_REST_BASE_URL: '',
      KIS_WS_BASE_URL: '',
    });

    expect(config.kis.enabled).toBe(false);
    expect(config.kis.canCallRestLive).toBe(false);
    expect(config.kis.canCallWebSocketLive).toBe(false);
  });

  it('keeps KIS live calls skipped when enabled but base URLs are empty', () => {
    const config = buildProviderConfig({
      KIS_MARKET_DATA_ENABLED: 'true',
      KIS_APP_KEY: 'app-key',
      KIS_APP_SECRET: 'app-secret',
      KIS_REST_BASE_URL: '',
      KIS_WS_BASE_URL: '',
    });

    expect(config.kis.enabled).toBe(true);
    expect(config.kis.canCallRestLive).toBe(false);
    expect(config.kis.canCallWebSocketLive).toBe(false);
  });

  it('parses KIS WebSocket env defaults and overrides', () => {
    const config = buildProviderConfig({
      KIS_WS_CUSTTYPE: 'P',
      KIS_WS_DOMESTIC_TR_ID: 'H0STCNT0',
      KIS_WS_OVERSEAS_DELAYED_TR_ID: 'HDFSCNT0',
      KIS_WS_SNAPSHOT_THROTTLE_MS: '2500',
      KIS_WS_MAX_RUNTIME_MS: '15000',
      KIS_WS_ALLOW_US_DELAYED: 'false',
    });

    expect(config.kis.wsCustType).toBe('P');
    expect(config.kis.wsDomesticTrId).toBe('H0STCNT0');
    expect(config.kis.wsOverseasDelayedTrId).toBe('HDFSCNT0');
    expect(config.kis.wsSnapshotThrottleMs).toBe(2500);
    expect(config.kis.wsMaxRuntimeMs).toBe(15000);
    expect(config.kis.wsAllowUsDelayed).toBe(false);
    expect(config.kis.wsStreamingEnabled).toBe(false);
    expect(config.kis.wsStreamingReconnectMinMs).toBe(1000);
    expect(config.kis.wsStreamingReconnectMaxMs).toBe(30000);
    expect(config.kis.wsStreamingHeartbeatTimeoutMs).toBe(60000);
  });

  it('parses KIS long-lived WebSocket streaming env overrides', () => {
    const config = buildProviderConfig({
      KIS_WEBSOCKET_STREAMING_ENABLED: 'true',
      KIS_WEBSOCKET_STREAMING_RECONNECT_MIN_MS: '250',
      KIS_WEBSOCKET_STREAMING_RECONNECT_MAX_MS: '5000',
      KIS_WEBSOCKET_STREAMING_HEARTBEAT_TIMEOUT_MS: '45000',
    });

    expect(config.kis.wsStreamingEnabled).toBe(true);
    expect(config.kis.wsStreamingReconnectMinMs).toBe(250);
    expect(config.kis.wsStreamingReconnectMaxMs).toBe(5000);
    expect(config.kis.wsStreamingHeartbeatTimeoutMs).toBe(45000);
  });

  it('parses KIS REST current-price and hoga path/TR_ID defaults and overrides', () => {
    const defaults = buildProviderConfig({});

    expect(defaults.kis.restDomesticCurrentPricePath).toBe(
      '/uapi/domestic-stock/v1/quotations/inquire-price',
    );
    expect(defaults.kis.restDomesticCurrentPriceTrId).toBe('FHKST01010100');
    expect(defaults.kis.restUsCurrentPricePath).toBe(
      '/uapi/overseas-price/v1/quotations/price',
    );
    expect(defaults.kis.restUsCurrentPriceTrId).toBe('HHDFS00000300');
    expect(defaults.kis.restDomesticHogaPath).toBe(
      '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
    );
    expect(defaults.kis.restDomesticHogaTrId).toBe('FHKST01010200');
    expect(defaults.kis.restUsHogaPath).toBe(
      '/uapi/overseas-price/v1/quotations/inquire-asking-price',
    );
    expect(defaults.kis.restUsHogaTrId).toBe('HHDFS76200100');

    const overrides = buildProviderConfig({
      KIS_REST_DOMESTIC_CURRENT_PRICE_PATH: '/domestic-price',
      KIS_REST_DOMESTIC_CURRENT_PRICE_TR_ID: 'DOMPRICE',
      KIS_REST_US_CURRENT_PRICE_PATH: '/us-price',
      KIS_REST_US_CURRENT_PRICE_TR_ID: 'USPRICE',
      KIS_REST_DOMESTIC_HOGA_PATH: '/domestic-hoga',
      KIS_REST_DOMESTIC_HOGA_TR_ID: 'DOMHOGA',
      KIS_REST_US_HOGA_PATH: '/us-hoga',
      KIS_REST_US_HOGA_TR_ID: 'USHOGA',
    });

    expect(overrides.kis.restDomesticCurrentPricePath).toBe('/domestic-price');
    expect(overrides.kis.restDomesticCurrentPriceTrId).toBe('DOMPRICE');
    expect(overrides.kis.restUsCurrentPricePath).toBe('/us-price');
    expect(overrides.kis.restUsCurrentPriceTrId).toBe('USPRICE');
    expect(overrides.kis.restDomesticHogaPath).toBe('/domestic-hoga');
    expect(overrides.kis.restDomesticHogaTrId).toBe('DOMHOGA');
    expect(overrides.kis.restUsHogaPath).toBe('/us-hoga');
    expect(overrides.kis.restUsHogaTrId).toBe('USHOGA');
  });

  it('parses Binance symbols as uppercase unique values', () => {
    const config = buildProviderConfig({
      BINANCE_CRYPTO_SYMBOLS: 'btcusdt, ETHUSDT,btcusdt,, ',
    });

    expect(config.binance.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('parses Binance WebSocket streaming env defaults and overrides', () => {
    const defaults = buildProviderConfig({});

    expect(defaults.binance.wsMarketDataBaseUrl).toBe(
      'wss://stream.binance.com:9443',
    );
    expect(defaults.binance.wsStreamingEnabled).toBe(false);
    expect(defaults.binance.wsStreamingReconnectMinMs).toBe(1000);
    expect(defaults.binance.wsStreamingReconnectMaxMs).toBe(30000);
    expect(defaults.binance.wsStreamingHeartbeatTimeoutMs).toBe(60000);
    expect(defaults.binance.wsSnapshotThrottleMs).toBe(5000);

    const config = buildProviderConfig({
      BINANCE_WS_MARKET_DATA_BASE_URL: 'wss://stream.binance.com:443',
      BINANCE_WEBSOCKET_STREAMING_ENABLED: 'true',
      BINANCE_WEBSOCKET_STREAMING_RECONNECT_MIN_MS: '250',
      BINANCE_WEBSOCKET_STREAMING_RECONNECT_MAX_MS: '5000',
      BINANCE_WEBSOCKET_STREAMING_HEARTBEAT_TIMEOUT_MS: '45000',
      BINANCE_WS_SNAPSHOT_THROTTLE_MS: '2000',
    });

    expect(config.binance.wsMarketDataBaseUrl).toBe(
      'wss://stream.binance.com:443',
    );
    expect(config.binance.wsStreamingEnabled).toBe(true);
    expect(config.binance.wsStreamingReconnectMinMs).toBe(250);
    expect(config.binance.wsStreamingReconnectMaxMs).toBe(5000);
    expect(config.binance.wsStreamingHeartbeatTimeoutMs).toBe(45000);
    expect(config.binance.wsSnapshotThrottleMs).toBe(2000);
  });
});
