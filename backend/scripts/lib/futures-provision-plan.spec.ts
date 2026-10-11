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
  it('creates only five underlyings and exactly 25 contracts; does not mutate inputs', () => {
    const before = JSON.stringify(assets);
    const p = futuresProvisionPlan(assets, [], contracts, at);
    expect(p.blockers).toEqual([]);
    expect(p.counts).toEqual({
      assets: { create: 5, maintain: 20, change: 0 },
      instruments: { create: 25, maintain: 0, change: 0 },
    });
    expect(p.createInstruments).toEqual(BINANCE_FUTURES_SYMBOLS);
    expect(JSON.stringify(assets)).toBe(before);
  });
  it('fails closed on missing contracts and never creates an absent shared Spot asset', () => {
    const c = new Map(contracts);
    c.delete('HYPEUSDT');
    const p = futuresProvisionPlan([], [], c, at);
    expect(p.blockers.length).toBe(21);
    expect(p.createAssets.length).toBe(5);
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
