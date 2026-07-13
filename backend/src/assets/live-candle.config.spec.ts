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
    const reconciliation = (
      krx = false,
      us = false,
      crypto = false,
    ) => ({
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
