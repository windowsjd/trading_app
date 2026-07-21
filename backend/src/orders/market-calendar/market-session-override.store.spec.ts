import {
  applyMarketSessionOverrideSnapshot,
  findActiveMarketSessionOverride,
  getMarketSessionOverrideRuntimeStatus,
  getMarketSessionOverrideStoreStatus,
  isMarketSessionOverrideStoreReady,
  markMarketSessionOverrideStoreRequired,
  recordMarketSessionOverrideRefreshFailure,
  resetMarketSessionOverrideStoreForTest,
} from './market-session-override.store';

describe('market session override store', () => {
  afterEach(() => {
    resetMarketSessionOverrideStoreForTest();
  });

  const closedEntry = {
    market: 'KRX' as const,
    localDate: '2026-07-13',
    overrideType: 'closed' as const,
    openTime: null,
    closeTime: null,
    reason: 'emergency closure',
  };

  it('starts in passthrough mode: ready with zero overrides', () => {
    expect(isMarketSessionOverrideStoreReady()).toBe(true);
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).toBeNull();
    expect(getMarketSessionOverrideStoreStatus()).toMatchObject({
      mode: 'passthrough',
      loaded: false,
      activeOverrideCount: 0,
    });
  });

  it('required mode is fail-closed until the first snapshot is applied', () => {
    markMarketSessionOverrideStoreRequired();
    expect(isMarketSessionOverrideStoreReady()).toBe(false);

    applyMarketSessionOverrideSnapshot([closedEntry], new Date());
    expect(isMarketSessionOverrideStoreReady()).toBe(true);
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).toMatchObject({
      overrideType: 'closed',
    });
  });

  it('distinguishes a regular override from the absence of an override', () => {
    applyMarketSessionOverrideSnapshot(
      [
        {
          market: 'KRX',
          localDate: '2026-01-01',
          overrideType: 'regular',
          openTime: null,
          closeTime: null,
          reason: 'force regular session',
        },
      ],
      new Date(),
    );

    expect(findActiveMarketSessionOverride('KRX', '2026-01-01')).toMatchObject({
      overrideType: 'regular',
    });
    expect(findActiveMarketSessionOverride('KRX', '2026-01-02')).toBeNull();
  });

  it('keys overrides by market: KRX and US never cross', () => {
    applyMarketSessionOverrideSnapshot([closedEntry], new Date());
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).not.toBeNull();
    expect(findActiveMarketSessionOverride('US', '2026-07-13')).toBeNull();
  });

  it('replaces the snapshot atomically: removed overrides disappear', () => {
    applyMarketSessionOverrideSnapshot([closedEntry], new Date());
    applyMarketSessionOverrideSnapshot([], new Date());
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).toBeNull();
    expect(isMarketSessionOverrideStoreReady()).toBe(true);
  });

  describe('runtime status for readiness', () => {
    it('reports passthrough when the loader never registered', () => {
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        mode: 'passthrough',
        state: 'passthrough',
      });
    });

    it('walks not_loaded → ready across a successful cold start', () => {
      markMarketSessionOverrideStoreRequired();
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        mode: 'required',
        state: 'not_loaded',
        loaded: false,
      });

      applyMarketSessionOverrideSnapshot([closedEntry], new Date());
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        state: 'ready',
        loaded: true,
        lastRefreshFailedAt: null,
        activeOverrideCount: 1,
      });
    });

    it('reports unavailable on a cold-start failure until a load succeeds', () => {
      markMarketSessionOverrideStoreRequired();
      const failedAt = new Date('2026-07-20T00:00:00.000Z');
      recordMarketSessionOverrideRefreshFailure(failedAt);
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        state: 'unavailable',
        loaded: false,
        lastRefreshFailedAt: failedAt,
      });
      expect(isMarketSessionOverrideStoreReady()).toBe(false);

      applyMarketSessionOverrideSnapshot([], new Date());
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        state: 'ready',
        lastRefreshFailedAt: null,
      });
    });

    it('reports last_known_good after a refresh failure and recovers on success', () => {
      markMarketSessionOverrideStoreRequired();
      applyMarketSessionOverrideSnapshot([closedEntry], new Date());
      recordMarketSessionOverrideRefreshFailure(new Date());
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        state: 'last_known_good',
        loaded: true,
      });
      // The last-known-good snapshot keeps serving while degraded.
      expect(isMarketSessionOverrideStoreReady()).toBe(true);
      expect(
        findActiveMarketSessionOverride('KRX', '2026-07-13'),
      ).not.toBeNull();

      applyMarketSessionOverrideSnapshot([closedEntry], new Date());
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        state: 'ready',
        lastRefreshFailedAt: null,
      });
    });
  });

  it('reset restores passthrough for test isolation', () => {
    markMarketSessionOverrideStoreRequired();
    applyMarketSessionOverrideSnapshot([closedEntry], new Date());
    resetMarketSessionOverrideStoreForTest();
    expect(getMarketSessionOverrideStoreStatus()).toMatchObject({
      mode: 'passthrough',
      loaded: false,
      activeOverrideCount: 0,
    });
  });
});
