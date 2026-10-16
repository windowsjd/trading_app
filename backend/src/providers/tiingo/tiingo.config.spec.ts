import {
  TIINGO_DEFAULT_OFFICIAL_SYMBOLS,
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
        TIINGO_SNAPSHOT_THROTTLE_MS: '10',
      }),
    );
    expect(config.httpTimeoutMs).toBe(5_000);
    expect(config.wsHeartbeatTimeoutMs).toBe(300_000);
    expect(config.requestsPerMinute).toBe(12);
    expect(config.snapshotThrottleMs).toBe(5_000);
  });

  it('waits 2.5 heartbeat intervals (Tiingo beats every 120 s) before calling the socket dead', () => {
    const config = readTiingoConfig(enabledEnv());
    expect(config.wsHeartbeatTimeoutMs).toBe(300_000);
    expect(config.wsHeartbeatTimeoutMs).toBeGreaterThan(2 * 120_000);
    expect(
      readTiingoConfig(enabledEnv({ TIINGO_WS_HEARTBEAT_TIMEOUT_MS: '180000' }))
        .wsHeartbeatTimeoutMs,
    ).toBe(180_000);
  });

  it('official mode (2026-10-17): persisted, production-ready, the fixed 25 US symbols by default', () => {
    const config = readTiingoConfig(
      enabledEnv({
        TIINGO_TRIAL_MODE: 'false',
        TIINGO_ALLOWED_SYMBOLS: '',
        NODE_ENV: 'production',
        RENDER: 'true',
      }),
    );
    expect(config).toMatchObject({
      enabled: true,
      configError: null,
      trialMode: false,
      persistenceEnabled: true,
      snapshotThrottleMs: 5_000,
      requestsPerMinute: 120,
      requestsPerHour: 3_000,
    });
    expect(config.allowedSymbols).toEqual([...TIINGO_DEFAULT_OFFICIAL_SYMBOLS]);
    expect(config.allowedSymbols.length).toBe(25);
    expect(config.allowedSymbols.includes('AAPL')).toBe(true);
    expect(config.allowedSymbols.includes('UBER')).toBe(true);
    // The trial stays memory-only and capped at 5.
    expect(readTiingoConfig(enabledEnv()).persistenceEnabled).toBe(false);
  });

  it('official mode accepts an explicit list up to 100 symbols, no more', () => {
    const list = (count: number) =>
      Array.from({ length: count }, (_, index) => `S${index}`).join(',');
    const ok = readTiingoConfig(
      enabledEnv({
        TIINGO_TRIAL_MODE: 'false',
        TIINGO_ALLOWED_SYMBOLS: list(100),
      }),
    );
    expect([ok.enabled, ok.allowedSymbols.length]).toEqual([true, 100]);
    const tooMany = readTiingoConfig(
      enabledEnv({
        TIINGO_TRIAL_MODE: 'false',
        TIINGO_ALLOWED_SYMBOLS: list(101),
      }),
    );
    expect([tooMany.enabled, tooMany.configError]).toEqual([
      false,
      'TIINGO_ALLOWED_SYMBOLS_LIMIT',
    ]);
  });

  it('maps NAS:AAPL style symbols to Tiingo tickers and back', () => {
    expect(toTiingoTicker('AAPL')).toBe('aapl');
    expect(toTiingoTicker('BRK.B')).toBe('brk-b');
    expect(fromTiingoTicker('brk-b')).toBe('BRK.B');
  });
});
