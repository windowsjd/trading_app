// Fixture HTTP and navigation only; account ownership, permissions at the API
// boundary, query lifecycle, Decimal formatting and production RN UI run intact.
import { apiClient as homeClient, transport as homeTransport } from './homeMocks';
import { futuresFixture } from '../futuresFixtures.cjs';
import { conditionalFixture } from '../conditionalFixtures.cjs';
const params = new URLSearchParams(location.search);
const kind = params.get('kind') ?? 'mixed';
const stressed = params.get('long') === '1';
const listeners = { focus: new Set(), blur: new Set() };
let focused = true;
export const navigation = {
  calls: [], isFocused: () => focused,
  navigate(...args) { this.calls.push(args); },
  addListener(event, listener) { listeners[event]?.add(listener); return () => listeners[event]?.delete(listener); },
  setFocused(value) { focused = value; listeners[value ? 'focus' : 'blur'].forEach(listener => listener()); },
};
export const useRootNavigation = () => navigation;
export const useHeaderHeight = () => 0;
export const transport = { ...homeTransport, reads: [], permission: 'available', failures: new Set(), gate: null,
  release() { this.gate?.release(); this.gate = null; },
  hold(domain) { let release; const promise = new Promise(resolve => { release = resolve; }); this.gate = { domain, promise, release }; },
};
transport.accounts.push({ ...transport.accounts[1], id: 'beginner-account', mode: 'beginner' });
homeTransport.accounts = transport.accounts;
const response = data => ({ data: { success: true, data } });
function spots(accountId) {
  if (kind === 'futures-only' || kind === 'empty') return [];
  const rows = [
    ['stock', '삼성전자', '005930', 'domestic_stock', 'KRX', 'KRW', '12.000000', '0', '0'],
    ['us', 'Berkshire Hathaway Class B', 'BRK.B', 'us_stock', 'NYSE', 'USD', '0.125000', '36.12', '0.25'],
    ['btc', 'Bitcoin', 'BTCUSDT', 'crypto', 'BINANCE', 'USD', '0.00000001', '-1234567890.12', '-99.12'],
  ];
  const types = { 'stock-only': 'domestic_stock', 'us-only': 'us_stock', 'crypto-only': 'crypto' };
  return rows.filter(row => !types[kind] || row[3] === types[kind]).map(([assetId, name, symbol, assetType, market, currencyCode, quantity, pnl, rate]) => ({
    positionId: `${accountId}:${assetId}`, assetId, name: stressed ? `${name} 대한민국 미래산업 투자기업 ABCDEFGHIJKLMNOPQRSTUVWXYZ` : name,
    symbol, assetType, market, currencyCode, quantity, averageCost: '100',
    valuation: kind === 'spot-unavailable' ? { state: 'unavailable', reason: 'ASSET_PRICE_UNAVAILABLE' } : {
      state: kind === 'spot-stale' ? 'stale_cache' : 'available', priceCurrency: currencyCode,
      positionValue: stressed ? '1234567890123456.12345678' : currencyCode === 'KRW' ? '750000' : '145.28',
      positionValueKrw: '9999999', unrealizedPnl: pnl, returnRate: rate,
    },
  }));
}
function futures(accountId) {
  const result = futuresFixture(accountId, { position: !['spot-only', 'stock-only', 'us-only', 'crypto-only', 'empty'].includes(kind),
    marginMode: params.get('margin') ?? 'cross', direction: params.get('direction') ?? 'short', large: stressed,
    stale: kind === 'mark-stale', leverage: 37 });
  if (stressed) result.catalog.instruments[0].underlying.name = 'Bitcoin 대한민국 암호화폐 선물 투자기업 ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return result;
}
async function before(domain, path) {
  transport.reads.push({ domain, path });
  if (transport.gate?.domain === domain || kind === `${domain}-delay`) await (transport.gate?.promise ?? new Promise(() => {}));
  if (transport.failures.has(domain) || kind === `${domain}-error`) throw new Error('Fixture unavailable');
}
export const apiClient = {
  async get(path, config) {
    if (path.includes('/season-summary')) {
      await before('friend', path);
      const own = futures('season-account').positions;
      return response({ state: 'available', user: { id: 'friend', nickname: '현재 시즌 친구', profileImageUrl: null },
        season: { id: 'season-1', name: '현재 시즌', status: 'active', rank: 2, provisionalTier: 'silver', finalTier: null,
          returnRate: '1', totalAssetKrw: '10000000', maxDrawdown: '2', percentile: '10', totalFillCount: 4 },
        portfolioAccess: transport.permission,
        portfolio: transport.permission === 'available' ? { valuationState: 'available',
          allocation: { cashKrwValue: '1000000', domesticStockValueKrw: '2000000', usStockValueKrw: '3000000', cryptoValueKrw: '4000000' },
          holdings: spots('season-account').map(row => ({ ...row, weight: '33.33333333' })),
          futures: { evaluatedAt: own.evaluatedAt, positions: own.positions.map(p => ({ ...p.instrument.underlying, direction: p.direction,
            marginMode: p.marginMode, leverage: p.leverage, markNotional: p.markNotional,
            markUnrealizedPnl: p.markUnrealizedPnl, roi: p.roi, markState: p.markState, markEvidence: p.markEvidence })) },
          history: [{ date: '2026-10-01', totalAssetKrw: '10000000', returnRate: '1' }] } : null });
    }
    const accountId = path.split('/')[2];
    if (path.includes('/futures/')) {
      const result = futures(accountId);
      if (path.endsWith('/positions')) { await before('futures', path); return response(result.positions); }
      if (path.endsWith('/instruments')) return response(result.catalog);
      if (path.endsWith('/executions')) return response(result.executions);
      if (path.endsWith('/liquidations')) return response(result.liquidations);
      if (path.endsWith('/final-settlement')) return response(result.final);
      if (path.includes('/limit-orders')) return response({ tradingAccountId: accountId, orders: [], pagination: { nextOffset: null } });
    }
    if (path.endsWith('/protections')) return response(conditionalFixture(accountId, { domain: config?.params?.domain ?? 'spot', enabled: true }));
    if (path.endsWith('/orders')) return response({ tradingAccountId: accountId, orders: [], pagination: { nextOffset: null } });
    if (path.endsWith('/positions')) {
      await before('spot', path);
      const query = config?.params ?? {}, offset = query.offset ?? 0, limit = query.limit ?? 20;
      const all = spots(accountId).filter(row => !query.assetType || row.assetType === query.assetType);
      const rows = all.slice(offset, offset + limit);
      return response({ tradingAccountId: accountId, state: 'available', positions: rows,
        pagination: { offset, limit, total: all.length, returned: rows.length, nextOffset: offset + rows.length < all.length ? offset + rows.length : null } });
    }
    return homeClient.get(path, config);
  },
  async post() { throw new Error('This layout fixture does not execute trades'); },
};
