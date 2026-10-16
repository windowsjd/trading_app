import { futuresProvisionPlan } from './futures-provision-plan';
import { BINANCE_FIXED_ASSET_UNIVERSE } from '../../src/providers/binance/binance-fixed-asset-universe';
import { BINANCE_FUTURES_SYMBOLS } from '../../src/providers/binance/binance-product-catalog';
import { parseFuturesContracts } from '../../src/futures/futures-instrument-coverage';
const at = new Date('2026-10-11T00:00:00Z');
const assets = BINANCE_FIXED_ASSET_UNIVERSE.map((a) => ({
  ...a,
  id: a.symbol,
  isActive: true,
})) as never;
const contracts = parseFuturesContracts({
  symbols: BINANCE_FUTURES_SYMBOLS.map((symbol) => ({
    symbol,
    pair: symbol,
    baseAsset: symbol.slice(0, -4),
    contractType: 'PERPETUAL',
    status: 'TRADING',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    underlyingType: 'COIN',
  })),
});
describe('selected Futures registration planning', () => {
  it('on an empty catalog creates the 21 Futures-only underlyings and all 100 contracts; does not mutate inputs', () => {
    const before = JSON.stringify(assets);
    const p = futuresProvisionPlan(assets, [], contracts, at);
    expect(p.blockers).toEqual([]);
    expect(p.counts).toEqual({
      assets: { create: 21, maintain: 79, change: 0 },
      instruments: { create: 100, maintain: 0, change: 0 },
    });
    expect(p.createInstruments).toEqual(BINANCE_FUTURES_SYMBOLS);
    expect(JSON.stringify(assets)).toBe(before);
  });
  it('upgrades the deployed 25 + 5 catalog: keeps every existing row, adds 20 underlyings and 75 contracts', () => {
    // Production before activation: the Spot seed has already registered the
    // Spot 100, reusing the four former Futures-only rows (same ids); HYPE
    // stays Futures-only; the original 25 contracts are verified.
    const deployed = [
      ...BINANCE_FIXED_ASSET_UNIVERSE.map((a) => ({
        ...a,
        id: a.symbol,
        isActive: true,
      })),
      {
        symbol: 'HYPEUSDT',
        name: 'Hyperliquid',
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
        id: 'HYPEUSDT',
        isActive: true,
      },
    ] as never;
    const instruments = BINANCE_FUTURES_SYMBOLS.slice(0, 25).map((symbol) => ({
      id: `instrument-${symbol}`,
      underlyingAssetId: symbol,
      productType: 'synthetic_perpetual',
      settlementCurrency: 'USD',
      isActive: true,
      markContractJson: contracts.get(symbol),
      markVerifiedAt: at,
    })) as never;
    const p = futuresProvisionPlan(deployed, instruments, contracts, at);
    expect(p.blockers).toEqual([]);
    expect(p.counts).toEqual({
      assets: { create: 20, maintain: 80, change: 0 },
      instruments: { create: 75, maintain: 25, change: 0 },
    });
    expect(p.createInstruments).toEqual(BINANCE_FUTURES_SYMBOLS.slice(25));
    expect(p.createAssets.map((a) => a.symbol)).not.toContain('HYPEUSDT');
  });
  it('fails closed on missing contracts and never creates an absent shared Spot asset', () => {
    const c = new Map(contracts);
    c.delete('HYPEUSDT');
    const p = futuresProvisionPlan([], [], c, at);
    // 79 shared Spot underlyings absent + the missing HYPE contract.
    expect(p.blockers.length).toBe(80);
    expect(p.createAssets.length).toBe(21);
    expect(p.blockers.some((b) => b.startsWith('HYPEUSDT:'))).toBe(true);
  });
  it('preserves nonselected financial lifetimes and reports inactive selected conflicts', () => {
    const i = [
      {
        id: 'dot',
        underlyingAssetId: 'PEPEUSDT',
        productType: 'synthetic_perpetual',
        settlementCurrency: 'USD',
        isActive: true,
      },
      {
        id: 'btc',
        underlyingAssetId: 'BTCUSDT',
        productType: 'synthetic_perpetual',
        settlementCurrency: 'USD',
        isActive: false,
      },
    ] as never;
    const p = futuresProvisionPlan(assets, i, contracts, at);
    expect(p.blockers.some((b) => b.includes('inactive instrument'))).toBe(
      true,
    );
    expect(p.outsideCatalog.map((r) => r.symbol)).toEqual(['PEPEUSDT']);
    expect(p.updateInstruments).toEqual(['BTCUSDT']);
  });
});
