import {
  TIINGO_DEFAULT_REST_BASE_URL,
  TIINGO_DEFAULT_WS_URL,
  fromTiingoTicker,
  readTiingoConfig,
  toTiingoTicker,
} from './tiingo.config';

const enabledEnv = (extra: Record<string, string> = {}) => ({
  TIINGO_ENABLED: 'true',
  TIINGO_API_TOKEN: 'synthetic-token',
  TIINGO_ALLOWED_SYMBOLS: 'AAPL',
  ...extra,
});

describe('readTiingoConfig', () => {
  it('is disabled by default with nothing allowed', () => {
    const config = readTiingoConfig({});
    expect(config).toMatchObject({
      requested: false,
      enabled: false,
      configError: null,
      allowedSymbols: [],
      trialMode: true,
      restBaseUrl: TIINGO_DEFAULT_REST_BASE_URL,
      wsUrl: TIINGO_DEFAULT_WS_URL,
    });
  });

  it('enables the explicit AAPL test universe', () => {
    const config = readTiingoConfig(enabledEnv());
    expect(config.enabled).toBe(true);
    expect(config.allowedSymbols).toEqual(['AAPL']);
    expect(config.streamEnabled).toBe(true);
    expect(config.liquidityStreamEnabled).toBe(true);
  });

  it.each([
    [{ TIINGO_API_TOKEN: '' }, 'TIINGO_TOKEN_MISSING'],
    [{ TIINGO_ALLOWED_SYMBOLS: '' }, 'TIINGO_ALLOWED_SYMBOLS_EMPTY'],
    [{ TIINGO_ALLOWED_SYMBOLS: 'NAS:AAPL' }, 'TIINGO_ALLOWED_SYMBOLS_INVALID'],
    [
      { TIINGO_ALLOWED_SYMBOLS: 'AAPL,MSFT,TSLA,NVDA,AMD,META' },
      'TIINGO_ALLOWED_SYMBOLS_LIMIT',
    ],
    [{ TIINGO_TRIAL_MODE: 'false' }, 'TIINGO_LICENSED_MODE_UNAVAILABLE'],
    [{ TIINGO_REST_BASE_URL: 'https://example.com' }, 'TIINGO_URL_INVALID'],
    [
      { TIINGO_WS_URL: 'ws://api.tiingo.com/equity/intraday' },
      'TIINGO_URL_INVALID',
    ],
    [{ NODE_ENV: 'production' }, 'TIINGO_TRIAL_PRODUCTION_BLOCKED'],
    [{ RENDER: 'true' }, 'TIINGO_TRIAL_PRODUCTION_BLOCKED'],
    [{ TIINGO_WS_ENABLED: 'yes' }, 'TIINGO_INVALID_FLAG'],
  ])('fails closed for %j', (extra, code) => {
    const config = readTiingoConfig(enabledEnv(extra));
    expect(config.enabled).toBe(false);
    expect(config.configError).toBe(code);
  });

  it('allows an internal production-like deployment only by explicit opt-in', () => {
    expect(
      readTiingoConfig(
        enabledEnv({
          NODE_ENV: 'production',
          TIINGO_ALLOW_PRODUCTION_TRIAL: 'true',
        }),
      ).enabled,
    ).toBe(true);
  });

  it('never fails when not requested, even with partial settings', () => {
    expect(
      readTiingoConfig({
        TIINGO_ALLOWED_SYMBOLS: 'NAS:AAPL',
        NODE_ENV: 'production',
      }),
    ).toMatchObject({ enabled: false, configError: null });
  });

  it('clamps numeric settings to safe bounds', () => {
    const config = readTiingoConfig(
      enabledEnv({
        TIINGO_HTTP_TIMEOUT_MS: '1',
        TIINGO_WS_HEARTBEAT_TIMEOUT_MS: '1000',
        TIINGO_REST_REQUESTS_PER_MINUTE: '12',
      }),
    );
    expect(config.httpTimeoutMs).toBe(5_000);
    expect(config.wsHeartbeatTimeoutMs).toBe(75_000);
    expect(config.requestsPerMinute).toBe(12);
  });

  it('maps NAS:AAPL style symbols to Tiingo tickers and back', () => {
    expect(toTiingoTicker('AAPL')).toBe('aapl');
    expect(toTiingoTicker('BRK.B')).toBe('brk-b');
    expect(fromTiingoTicker('brk-b')).toBe('BRK.B');
  });
});
