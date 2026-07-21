import {
  applyMarketSessionOverrideSnapshot,
  findActiveMarketSessionOverride,
  getMarketSessionOverrideStoreStatus,
  isMarketSessionOverrideStoreReady,
  markMarketSessionOverrideStoreRequired,
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
