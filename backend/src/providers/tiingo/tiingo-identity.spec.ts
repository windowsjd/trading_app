import { tiingoExchangeMatchesAssetMarket } from './tiingo-identity';
import { TIINGO_DEFAULT_OFFICIAL_SYMBOLS } from './tiingo.config';
import { KIS_FIXED_ASSET_UNIVERSE } from '../kis/kis-fixed-asset-universe';

describe('tiingoExchangeMatchesAssetMarket', () => {
  it('pairs NAS with NASDAQ and NYS with NYSE only', () => {
    expect(tiingoExchangeMatchesAssetMarket('NASDAQ', 'NAS')).toBe(true);
    expect(tiingoExchangeMatchesAssetMarket(' nasdaq ', 'nas')).toBe(true);
    expect(tiingoExchangeMatchesAssetMarket('NYSE', 'NYS')).toBe(true);
    expect(tiingoExchangeMatchesAssetMarket('NYSE', 'NAS')).toBe(false);
    expect(tiingoExchangeMatchesAssetMarket('NASDAQ', 'NYS')).toBe(false);
    expect(tiingoExchangeMatchesAssetMarket(null, 'NAS')).toBe(false);
    // AMEX/Arca listings are outside the fixed universe: never matched.
    expect(tiingoExchangeMatchesAssetMarket('NYSE ARCA', 'AMS')).toBe(false);
    expect(tiingoExchangeMatchesAssetMarket('NYSE MKT', 'AMS')).toBe(false);
  });

  it('covers every official default symbol (all listed on NAS or NYS)', () => {
    const markets = new Map(
      KIS_FIXED_ASSET_UNIVERSE.filter(
        (entry) => entry.assetType === 'us_stock',
      ).map((entry) => [entry.symbol, entry.market]),
    );
    expect(TIINGO_DEFAULT_OFFICIAL_SYMBOLS.length).toBe(25);
    for (const symbol of TIINGO_DEFAULT_OFFICIAL_SYMBOLS)
      expect(['NAS', 'NYS'].includes(markets.get(symbol) ?? '')).toBe(true);
  });
});
