import {
  BINANCE_FIXED_ASSET_UNIVERSE,
  BINANCE_FIXED_SYMBOLS,
} from './binance-fixed-asset-universe';
import selection from '../../../artifacts/binance-universe-2026/selection.json';
import originalUniverse from '../../../artifacts/binance-universe-2026/original-universe.json';

describe('BINANCE_FIXED_ASSET_UNIVERSE', () => {
  it('preserves all ten original contracts and appends exactly the researched top fifteen', () => {
    expect(BINANCE_FIXED_ASSET_UNIVERSE).toHaveLength(25);
    expect(BINANCE_FIXED_ASSET_UNIVERSE.slice(0, 10)).toEqual(originalUniverse);
    expect(selection.selected).toHaveLength(15);
    expect(BINANCE_FIXED_ASSET_UNIVERSE.slice(10)).toEqual(
      selection.selected.map((entry) => ({
        symbol: entry.symbol,
        baseAsset: entry.baseAsset,
        name: entry.name,
        priceTickSize: entry.tickSize,
        displayPriceDecimals: entry.displayPriceDecimals,
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      })),
    );
  });

  it('keeps the pre-existing BTC and ETH symbols', () => {
    const baseAssets = BINANCE_FIXED_ASSET_UNIVERSE.map((e) => e.baseAsset);
    expect(baseAssets).toContain('BTC');
    expect(baseAssets).toContain('ETH');
  });

  it('applies the DB contract to every entry (BINANCE / crypto / USD, USDT Spot pair)', () => {
    for (const entry of BINANCE_FIXED_ASSET_UNIVERSE) {
      expect(entry.market).toBe('BINANCE');
      expect(entry.assetType).toBe('crypto');
      expect(entry.currencyCode).toBe('USD');
      expect(entry.priceCurrency).toBe('USD');
      expect(entry.settlementCurrency).toBe('USD');
      // Real Binance Spot trading symbol in BASE + USDT form.
      expect(entry.symbol).toBe(`${entry.baseAsset}USDT`);
      expect(entry.symbol).toMatch(/^[A-Z0-9\p{Script=Han}]+USDT$/u);
      expect(entry.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('has unique symbols and base assets', () => {
    const symbols = BINANCE_FIXED_ASSET_UNIVERSE.map((e) => e.symbol);
    const baseAssets = BINANCE_FIXED_ASSET_UNIVERSE.map((e) => e.baseAsset);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(new Set(baseAssets).size).toBe(baseAssets.length);
  });

  it('excludes stablecoins and wrapped/pegged assets', () => {
    const excluded = new Set([
      'USDT',
      'USDC',
      'FDUSD',
      'TUSD',
      'DAI',
      'BUSD',
      'USDP',
      'WBTC',
      'WETH',
      'WBETH',
      'STETH',
    ]);
    for (const entry of BINANCE_FIXED_ASSET_UNIVERSE) {
      expect(excluded.has(entry.baseAsset)).toBe(false);
    }
  });

  it('exposes BINANCE_FIXED_SYMBOLS aligned with the universe', () => {
    expect(BINANCE_FIXED_SYMBOLS).toEqual(
      BINANCE_FIXED_ASSET_UNIVERSE.map((e) => e.symbol),
    );
  });
});
