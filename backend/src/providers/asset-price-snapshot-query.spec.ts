jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: { Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal },
}));
import { Prisma } from '../generated/prisma/client';
import { closedMarketPriceScope, findMarketAwareAssetPriceCandidates } from './asset-price-snapshot-query';
import { selectMarketAwareAssetPriceSnapshotBySourcePriority } from './source-eligibility.policy';
import { applyMarketSessionOverrideSnapshot, resetMarketSessionOverrideStoreForTest } from '../orders/market-calendar/market-session-override.store';

const asset = { id: 'samsung', assetType: 'domestic_stock' as const, market: 'KRX', currencyCode: 'KRW' as const };
const source = 'kis_krx_realtime_trade';
const row = (time: string, price: string, sourceName = source) => ({
  id: `${time}-${price}-${sourceName}`, assetId: asset.id, currencyCode: 'KRW' as const,
  sourceType: 'provider_api', sourceName, price: new Prisma.Decimal(price),
  effectiveAt: new Date(`2026-07-17T${time}Z`), capturedAt: new Date(`2026-07-17T${time}Z`),
});
const regular = [row('06:20:00', '247000'), row('06:28:00', '248000'), row('06:30:00', '248500')];
const noise = [
  ...Array.from({length: 25}, (_, i) => row(`07:${String(i).padStart(2, '0')}:00`, '999999')),
  ...Array.from({length: 15}, (_, i) => row(`06:29:${String(i).padStart(2, '0')}`, '999999', 'wrong_source')),
  row('06:30:00', '0'),
];
function database(rows: ReturnType<typeof row>[]) {
  return { assetPriceSnapshot: { findMany: jest.fn(async ({where, take}) => rows.filter(r =>
    r.assetId === where.assetId && r.currencyCode === where.currencyCode && r.sourceType === where.sourceType &&
    (!where.sourceName || r.sourceName === where.sourceName) &&
    (!where.price || r.price.gt(where.price.gt)) &&
    (!where.id || where.id.in.includes(r.id)) &&
    (!where.effectiveAt || (r.effectiveAt >= where.effectiveAt.gte && r.effectiveAt <= where.effectiveAt.lte))
  ).sort((a,b) => b.effectiveAt.getTime() - a.effectiveAt.getTime()).slice(0, take)) } };
}
afterEach(() => resetMarketSessionOverrideStoreForTest());
describe('completed-session DB candidate selection', () => {
  it.each(['2026-07-17T09:00:00Z', '2026-07-18T09:00:00Z', '2026-07-19T09:00:00Z'])('selects 15:30 through post-close noise at %s', async at => {
    const db = database([...regular, ...noise]);
    const now = new Date(at);
    const input = { asset, now, workflow: 'assets_with_price' as const, sourceNames: [source] };
    const candidates = await findMarketAwareAssetPriceCandidates(db as never, input);
    expect(candidates.map(x => x.price.toFixed(0))).toEqual(['248500']);
    expect(db.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(db.assetPriceSnapshot.findMany).toHaveBeenCalledWith(expect.objectContaining({take: 1, where: expect.objectContaining({
      effectiveAt: {gte: new Date('2026-07-17T00:00:00Z'), lte: new Date('2026-07-17T06:30:00Z')}, sourceName: source, price: {gt: 0},
    })}));
  });
  it('finds the last trading day across a public holiday', async () => {
    const input = { asset, now: new Date('2026-07-20T09:00:00Z'), workflow: 'assets_with_price' as const };
    applyMarketSessionOverrideSnapshot([{market: 'KRX', localDate: '2026-07-20', overrideType: 'closed', openTime: null, closeTime: null, reason: 'test holiday'}], input.now);
    expect(closedMarketPriceScope(input)?.marketState?.latestCompletedSession?.localDate).toBe('2026-07-17');
  });
  it('keeps late closing evidence based on effectiveAt, not capturedAt', async () => {
    const close = {...regular[2], capturedAt: new Date('2026-07-17T06:30:02Z')};
    const input = { asset, now: new Date('2026-07-17T09:00:00Z'), workflow: 'live_portfolio_valuation' as const, sourceNames: [source] };
    const candidates = await findMarketAwareAssetPriceCandidates(database([close,...noise]) as never, input);
    const result = selectMarketAwareAssetPriceSnapshotBySourcePriority({...input, candidates, expectedSourceNames: [source], freshnessThresholdSeconds: 300, isPositiveValue: c => c.price.gt(0)});
    expect(result.state).toBe('selected');
    if (result.state === 'selected') expect(result.snapshot.id).toBe(close.id);
  });
  it('retains rejected evidence but never selects it when the completed session is empty', async () => {
    const input = { asset, now: new Date('2026-07-17T09:00:00Z'), workflow: 'live_portfolio_valuation' as const, sourceNames: [source] };
    const candidates = await findMarketAwareAssetPriceCandidates(database(noise.filter(r => r.effectiveAt > regular[2].effectiveAt)) as never, input);
    const result = selectMarketAwareAssetPriceSnapshotBySourcePriority({...input, candidates, expectedSourceNames: [source], freshnessThresholdSeconds: 300, isPositiveValue: c => c.price.gt(0)});
    expect(result).toMatchObject({state: 'not_selected', decision: {rejectedProviderReason: 'effective_at_outside_last_completed_session'}});
  });
  it('does not change crypto, open-market or order candidate scopes', () => {
    const input = {asset, now: new Date('2026-07-17T03:00:00Z'), workflow: 'assets_with_price' as const};
    expect(closedMarketPriceScope(input)).toBeNull();
    expect(closedMarketPriceScope({...input, now: new Date('2026-07-17T09:00:00Z'), workflow: 'orders_quote'})).toBeNull();
    expect(closedMarketPriceScope({...input, asset: {...asset, assetType: 'crypto', market: 'BINANCE'}})).toBeNull();
  });
  it('does not allow a manual fallback when calendar coverage is unavailable', () => {
    expect(closedMarketPriceScope({asset, now: new Date('2030-07-17T09:00:00Z'), workflow: 'assets_with_price'})?.where).toEqual({id: {in: []}});
  });
});
