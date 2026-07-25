import {
  type AssetUniverseDesired,
  type AssetUniverseExisting,
  diffAssetUniverseFields,
  planAssetUniverseUpserts,
  summarizeAssetUniversePlan,
} from './asset-universe-upsert';

const desired = (
  over: Partial<AssetUniverseDesired> = {},
): AssetUniverseDesired => ({
  symbol: 'BTCUSDT',
  name: 'Bitcoin',
  market: 'BINANCE',
  assetType: 'crypto',
  currencyCode: 'USD',
  priceCurrency: 'USD',
  settlementCurrency: 'USD',
  ...over,
});

const existing = (
  over: Partial<AssetUniverseExisting> = {},
): AssetUniverseExisting => ({
  id: 'asset-1',
  symbol: 'BTCUSDT',
  market: 'BINANCE',
  name: 'Bitcoin',
  assetType: 'crypto',
  currencyCode: 'USD',
  priceCurrency: 'USD',
  settlementCurrency: 'USD',
  isActive: true,
  ...over,
});

describe('planAssetUniverseUpserts', () => {
  it('plans a create when no row matches (market, symbol)', () => {
    const plan = planAssetUniverseUpserts([desired()], []);
    expect(summarizeAssetUniversePlan(plan)).toEqual({
      total: 1,
      create: 1,
      update: 0,
      unchanged: 0,
    });
    expect(plan.creates[0].desired.symbol).toBe('BTCUSDT');
  });

  it('plans unchanged when every contract field already matches and row is active', () => {
    const plan = planAssetUniverseUpserts([desired()], [existing()]);
    expect(summarizeAssetUniversePlan(plan)).toEqual({
      total: 1,
      create: 0,
      update: 0,
      unchanged: 1,
    });
    expect(plan.unchanged[0].existingId).toBe('asset-1');
  });

  it('plans an update listing only changed contract fields', () => {
    const plan = planAssetUniverseUpserts(
      [desired({ name: 'Bitcoin' })],
      [existing({ name: 'BTC old name', isActive: false })],
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].changedFields).toEqual(['name', 'isActive']);
  });

  it('matches strictly on (market, symbol); same symbol on another market is a create', () => {
    const plan = planAssetUniverseUpserts(
      [desired({ symbol: 'ETHUSDT', name: 'Ethereum' })],
      [existing({ symbol: 'ETHUSDT', market: 'OTHER', name: 'Ethereum' })],
    );
    expect(summarizeAssetUniversePlan(plan).create).toBe(1);
    expect(summarizeAssetUniversePlan(plan).unchanged).toBe(0);
  });

  it('reactivates an inactive but otherwise-identical row via isActive change only', () => {
    const plan = planAssetUniverseUpserts(
      [desired()],
      [existing({ isActive: false })],
    );
    expect(plan.updates[0].changedFields).toEqual(['isActive']);
  });
});

describe('diffAssetUniverseFields', () => {
  it('reports each mismatched contract field but never symbol or market', () => {
    const changed = diffAssetUniverseFields(
      existing({
        name: 'old',
        currencyCode: 'KRW',
        priceCurrency: 'KRW',
        settlementCurrency: 'KRW',
        assetType: 'us_stock',
        isActive: false,
      }),
      desired(),
    );
    expect(changed).toEqual([
      'name',
      'currencyCode',
      'priceCurrency',
      'settlementCurrency',
      'assetType',
      'isActive',
    ]);
  });
});
