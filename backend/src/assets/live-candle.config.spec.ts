import {
  LiveCandleConfigError,
  readLiveCandleConfig,
  validateLiveReconciliationDependencies,
} from './live-candle.config';

describe('readLiveCandleConfig', () => {
  it('is opt-in and supplies bounded defaults', () => {
    const config = readLiveCandleConfig({});
    expect(config).toMatchObject({
      enabled: false,
      kisEnabled: false,
      kisUsDelayedEnabled: false,
      binanceEnabled: false,
      ownerLeaseTtlMs: 30_000,
      ownerLeaseRenewMs: 10_000,
      maxSubscriptionsPerClient: 20,
      // Connection liveness (watchdog) is deliberately longer than trade
      // freshness (readiness): a quiet-but-heartbeating socket stays open
      // well past the point its market data is reported stale.
      connectionLivenessTimeoutMs: 90_000,
      tradeStaleThresholdMs: 30_000,
    });
  });

  it('rejects boolean typos and invalid lease/backoff relationships', () => {
    expect(() =>
      readLiveCandleConfig({ CANDLE_LIVE_STREAMING_ENABLED: 'tru' }),
    ).toThrow(LiveCandleConfigError);
    expect(() =>
      readLiveCandleConfig({
        CANDLE_LIVE_OWNER_LEASE_TTL_MS: '10000',
        CANDLE_LIVE_OWNER_LEASE_RENEW_MS: '10000',
      }),
    ).toThrow(/greater than/u);
    expect(() =>
      readLiveCandleConfig({
        CANDLE_LIVE_RECONNECT_MIN_MS: '5000',
        CANDLE_LIVE_RECONNECT_MAX_MS: '1000',
      }),
    ).toThrow(/less than or equal/u);
  });

  describe('connection liveness vs trade freshness configuration', () => {
    it('reads the two dedicated variables independently', () => {
      const config = readLiveCandleConfig({
        CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS: '120000',
        CANDLE_LIVE_TRADE_STALE_THRESHOLD_MS: '20000',
      });
      expect(config.connectionLivenessTimeoutMs).toBe(120_000);
      expect(config.tradeStaleThresholdMs).toBe(20_000);
    });

    it('falls back to the deprecated CANDLE_LIVE_STALE_THRESHOLD_MS for both', () => {
      const config = readLiveCandleConfig({
        CANDLE_LIVE_STALE_THRESHOLD_MS: '45000',
      });
      expect(config.connectionLivenessTimeoutMs).toBe(45_000);
      expect(config.tradeStaleThresholdMs).toBe(45_000);
    });

    it('prefers the dedicated variables over the deprecated one', () => {
      const config = readLiveCandleConfig({
        CANDLE_LIVE_STALE_THRESHOLD_MS: '45000',
        CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS: '90000',
        CANDLE_LIVE_TRADE_STALE_THRESHOLD_MS: '15000',
      });
      expect(config.connectionLivenessTimeoutMs).toBe(90_000);
      expect(config.tradeStaleThresholdMs).toBe(15_000);
    });

    it('rejects invalid or out-of-range values instead of silently falling back', () => {
      expect(() =>
        readLiveCandleConfig({
          CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS: 'ninety',
        }),
      ).toThrow(LiveCandleConfigError);
      // A liveness timeout that short would reconnect healthy sockets.
      expect(() =>
        readLiveCandleConfig({
          CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS: '1000',
        }),
      ).toThrow(/between 5000 and/u);
      expect(() =>
        readLiveCandleConfig({
          CANDLE_LIVE_TRADE_STALE_THRESHOLD_MS: '0',
        }),
      ).toThrow(LiveCandleConfigError);
      // An invalid deprecated value is a config error, never a silent default.
      expect(() =>
        readLiveCandleConfig({ CANDLE_LIVE_STALE_THRESHOLD_MS: 'abc' }),
      ).toThrow(/deprecated fallback/u);
    });

    it('rejects a liveness timeout shorter than the trade-stale threshold', () => {
      expect(() =>
        readLiveCandleConfig({
          CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS: '10000',
          CANDLE_LIVE_TRADE_STALE_THRESHOLD_MS: '30000',
        }),
      ).toThrow(/greater than or equal/u);
      // Equal values remain valid (the deprecated variable sets both).
      expect(() =>
        readLiveCandleConfig({ CANDLE_LIVE_STALE_THRESHOLD_MS: '30000' }),
      ).not.toThrow();
    });
  });

  it('does not allow the US delayed feed to be silently enabled alone', () => {
    expect(() =>
      readLiveCandleConfig({ CANDLE_LIVE_KIS_US_DELAYED_ENABLED: 'true' }),
    ).toThrow(/requires live streaming/u);
  });

  describe('live/reconciliation dependency validation', () => {
    const live = (overrides: Record<string, string>) =>
      readLiveCandleConfig({
        CANDLE_LIVE_STREAMING_ENABLED: 'true',
        ...overrides,
      });
    const reconciliation = (krx = false, us = false, crypto = false) => ({
      krx: { enabled: krx },
      us: { enabled: us },
      crypto: { enabled: crypto },
    });

    it('refuses production startup for each live-without-reconciliation combination', () => {
      expect(() =>
        validateLiveReconciliationDependencies({
          live: live({ CANDLE_LIVE_KIS_ENABLED: 'true' }),
          reconciliation: reconciliation(false, false, true),
          nodeEnv: 'production',
        }),
      ).toThrow(LiveCandleConfigError);
      expect(() =>
        validateLiveReconciliationDependencies({
          live: live({
            CANDLE_LIVE_KIS_ENABLED: 'true',
            CANDLE_LIVE_KIS_US_DELAYED_ENABLED: 'true',
          }),
          reconciliation: reconciliation(true, false, true),
          nodeEnv: 'production',
        }),
      ).toThrow(/CANDLE_RECONCILIATION_US_ENABLED/u);
      expect(() =>
        validateLiveReconciliationDependencies({
          live: live({ CANDLE_LIVE_BINANCE_ENABLED: 'true' }),
          reconciliation: reconciliation(true, true, false),
          nodeEnv: 'production',
        }),
      ).toThrow(/CANDLE_RECONCILIATION_CRYPTO_ENABLED/u);
    });

    it('passes when every enabled live market has its reconciliation', () => {
      expect(
        validateLiveReconciliationDependencies({
          live: live({
            CANDLE_LIVE_KIS_ENABLED: 'true',
            CANDLE_LIVE_BINANCE_ENABLED: 'true',
          }),
          reconciliation: reconciliation(true, false, true),
          nodeEnv: 'production',
        }),
      ).toEqual([]);
    });

    it('returns warnings instead of throwing outside production', () => {
      const warnings = validateLiveReconciliationDependencies({
        live: live({ CANDLE_LIVE_BINANCE_ENABLED: 'true' }),
        reconciliation: reconciliation(false, false, false),
        nodeEnv: 'development',
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('CANDLE_RECONCILIATION_CRYPTO_ENABLED');
    });

    it('honors the explicit escape hatch in production', () => {
      const warnings = validateLiveReconciliationDependencies({
        live: live({
          CANDLE_LIVE_BINANCE_ENABLED: 'true',
          LIVE_CANDLE_ALLOW_WITHOUT_RECONCILIATION: 'true',
        }),
        reconciliation: reconciliation(false, false, false),
        nodeEnv: 'production',
      });
      expect(warnings).toHaveLength(1);
    });

    it('does not constrain disabled live streaming', () => {
      expect(
        validateLiveReconciliationDependencies({
          live: readLiveCandleConfig({}),
          reconciliation: reconciliation(false, false, false),
          nodeEnv: 'production',
        }),
      ).toEqual([]);
    });
  });
});
