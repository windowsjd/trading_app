import { buildProviderConfig } from './provider-config.service';
import { ProviderConfigError } from './provider.types';

describe('provider config', () => {
  it('allows all providers disabled with missing secrets', () => {
    const config = buildProviderConfig({});

    expect(config.common.providerIngestionEnabled).toBe(false);
    expect(config.exchangeRateApi.enabled).toBe(false);
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
  });

  it('parses Binance symbols as uppercase unique values', () => {
    const config = buildProviderConfig({
      BINANCE_CRYPTO_SYMBOLS: 'btcusdt, ETHUSDT,btcusdt,, ',
    });

    expect(config.binance.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});
