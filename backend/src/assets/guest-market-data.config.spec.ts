import {
  isGuestFuturesMarketDataEnabled,
  readGuestMarketDataAssetTypes,
  readGuestMarketDataScopes,
} from './guest-market-data.config';

describe('readGuestMarketDataAssetTypes', () => {
  it('serves every market unless the operator narrows it (the default since 2026-10-30)', () => {
    for (const env of [{}, { GUEST_MARKET_DATA_ASSET_TYPES: '  ' }]) {
      expect(readGuestMarketDataScopes(env)).toEqual([
        'domestic_stock',
        'us_stock',
        'crypto',
        'crypto_futures',
      ]);
      expect(readGuestMarketDataAssetTypes(env)).toEqual([
        'domestic_stock',
        'us_stock',
        'crypto',
      ]);
      expect(isGuestFuturesMarketDataEnabled(env)).toBe(true);
    }
  });

  it('turns guest market data off with none', () => {
    const env = { GUEST_MARKET_DATA_ASSET_TYPES: ' none ' };
    expect(readGuestMarketDataScopes(env)).toEqual([]);
    expect(readGuestMarketDataAssetTypes(env)).toEqual([]);
    expect(isGuestFuturesMarketDataEnabled(env)).toBe(false);
  });

  it('reads exact, trimmed, distinct asset types in order', () => {
    expect(
      readGuestMarketDataAssetTypes({
        GUEST_MARKET_DATA_ASSET_TYPES: ' crypto , us_stock ',
      }),
    ).toEqual(['crypto', 'us_stock']);
  });

  it('keeps futures market data a scope of its own, never a spot asset type', () => {
    const env = { GUEST_MARKET_DATA_ASSET_TYPES: 'crypto_futures' };
    expect(readGuestMarketDataScopes(env)).toEqual(['crypto_futures']);
    expect(readGuestMarketDataAssetTypes(env)).toEqual([]);
    expect(isGuestFuturesMarketDataEnabled(env)).toBe(true);
    // Spot crypto does not open futures, nor the reverse.
    const spot = { GUEST_MARKET_DATA_ASSET_TYPES: 'crypto' };
    expect(isGuestFuturesMarketDataEnabled(spot)).toBe(false);
    expect(
      readGuestMarketDataAssetTypes({
        GUEST_MARKET_DATA_ASSET_TYPES: 'crypto_futures,crypto',
      }),
    ).toEqual(['crypto']);
  });

  it.each([
    'Crypto',
    'crypto,crypto',
    'crypto,,us_stock',
    'stocks',
    'futures',
    'crypto_futures,crypto_futures',
    'none,crypto',
    'NONE',
  ])('rejects %j instead of guessing a scope', (value) => {
    expect(() =>
      readGuestMarketDataScopes({ GUEST_MARKET_DATA_ASSET_TYPES: value }),
    ).toThrow('GUEST_MARKET_DATA_ASSET_TYPES');
    expect(() =>
      readGuestMarketDataAssetTypes({ GUEST_MARKET_DATA_ASSET_TYPES: value }),
    ).toThrow('GUEST_MARKET_DATA_ASSET_TYPES');
  });
});
