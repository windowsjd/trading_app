import {
  LiveCandleConfigError,
  readLiveCandleConfig,
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
});
