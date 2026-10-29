import { readGuestMarketDataAssetTypes } from './guest-market-data.config';

describe('readGuestMarketDataAssetTypes', () => {
  it('exposes nothing unless the operator lists a type', () => {
    expect(readGuestMarketDataAssetTypes({})).toEqual([]);
    expect(
      readGuestMarketDataAssetTypes({ GUEST_MARKET_DATA_ASSET_TYPES: '  ' }),
    ).toEqual([]);
  });

  it('reads exact, trimmed, distinct asset types in order', () => {
    expect(
      readGuestMarketDataAssetTypes({
        GUEST_MARKET_DATA_ASSET_TYPES: ' crypto , us_stock ',
      }),
    ).toEqual(['crypto', 'us_stock']);
  });

  it.each(['Crypto', 'crypto,crypto', 'crypto,,us_stock', 'stocks'])(
    'rejects %j instead of guessing a scope',
    (value) => {
      expect(() =>
        readGuestMarketDataAssetTypes({ GUEST_MARKET_DATA_ASSET_TYPES: value }),
      ).toThrow('GUEST_MARKET_DATA_ASSET_TYPES');
    },
  );
});
