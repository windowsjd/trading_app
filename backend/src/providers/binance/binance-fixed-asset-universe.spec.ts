import {
  BINANCE_FIXED_ASSET_UNIVERSE,
  BINANCE_FIXED_SYMBOLS,
} from './binance-fixed-asset-universe';

describe('BINANCE_FIXED_ASSET_UNIVERSE', () => {
  it('is exactly the reviewed fixed 10-symbol MVP universe', () => {
    expect(BINANCE_FIXED_ASSET_UNIVERSE.map((e) => e.symbol)).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'BNBUSDT',
      'XRPUSDT',
      'SOLUSDT',
      'TRXUSDT',
      'DOGEUSDT',
      'ZECUSDT',
      'XLMUSDT',
      'LINKUSDT',
    ]);
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
      expect(entry.symbol).toMatch(/^[A-Z0-9]+USDT$/u);
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
