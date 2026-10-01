// The production screens, query observers and API mappers run unchanged.
// REST/WebSocket transport and navigation are the browser fixture boundaries.
import { apiClient as homeClient, navigation, transport } from './homeMocks';
export { navigation, transport };
export const useRootNavigation = () => navigation;
const params = new URLSearchParams(location.search);
const long = params.get('long') === '1';
if (params.has('navigation')) transport.accounts[0].season.seasonId = 'record-0';
navigation.reset = (...args) => navigation.calls.push(['reset', ...args]);
const response = (data) => ({ data: { success: true, data } });
const pagination = (offset, limit, total) => ({
  offset, limit, total, returned: Math.min(limit, total - offset),
  nextOffset: offset + limit < total ? offset + limit : null,
});
const tickerSnapshot = { tickersByAssetId: new Map(), staleAssetIds: new Set(), showReconnectBanner: false };
export const useMarketTickers = () => tickerSnapshot;

export const apiClient = {
  async post() { return response({}); },
  async get(path, config) {
    const url = new URL(path, 'https://fixture.invalid');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    if (url.pathname === '/assets') {
      transport.requests.push(path);
      const page = pagination(offset, limit, 44);
      return response({ pagination: page, assets: Array.from({ length: page.returned }, (_, i) => ({
        id: `asset-${offset + i}`, assetType: url.searchParams.get('assetType') ?? 'domestic_stock',
        symbol: '005930', name: long ? '대한민국 미래산업 우량주 투자기업 우선주' : '삼성전자',
        market: 'KRX', priceCurrency: 'KRW', settlementCurrency: 'KRW',
        isActive: true, marketStatus: url.searchParams.get('assetType') === 'crypto' ? 'always_open' : params.get('session') ?? 'open',
        tradable: params.get('session') !== 'closed', tradeBlockedReason: params.get('session') === 'closed' ? 'MARKET_CLOSED' : null,
        price: { state: 'available', currentPrice: params.has('hugePrice') ? '1234567890123456' : '70000', priceCurrency: 'KRW', changeRate: ['1.25', '-3.52', '0', null][i % 4] },
      })) });
    }
    if (url.pathname === '/ranking' && limit > 1) {
      transport.requests.push(path);
      const page = pagination(offset, limit, 53);
      const rankings = Array.from({ length: page.returned }, (_, i) => ({
        seasonParticipantId: `participant-${offset + i}`, userId: `user-${offset + i}`,
        profileImageUrl: params.get('profile') === 'valid' ? `${location.origin}/avatar.svg` : params.get('profile') === 'broken' ? `${location.origin}/missing-avatar.png` : null,
        rank: params.has('hugeRank') ? 123456789 : offset + i + 1, nickname: long ? '아주긴닉네임대한민국투자챔피언ABCDEFGHIJKLMNOPQRSTUVWXYZ' : `투자자 ${offset + i + 1}`,
        provisionalTier: long ? 'Silver 대한민국 특별 경쟁 등급' : 'Silver', finalTier: 'Gold',
        returnRate: '4.82', percentile: '99.5', totalAssetKrw: '10482000',
        maxDrawdown: '0', totalFillCount: 3, capturedAt: '2026-09-01T00:00:00Z',
      }));
      return response({
        state: 'available', pagination: page, rankings,
        myRanking: { ...rankings[0], state: 'available' },
        rankType: 'daily', rankingDate: '2026-09-01', capturedAt: '2026-09-01T00:00:00Z',
      });
    }
    if (url.pathname === '/records/me/seasons') {
      transport.requests.push(path);
      const page = pagination(offset, limit, 23);
      return response({ pagination: page, seasons: Array.from({ length: page.returned }, (_, i) => ({
        seasonId: `record-${offset + i}`, seasonName: long ? '대한민국 모의투자 챔피언십 특별 경쟁 시즌' : `Season ${offset + i + 1}`,
        joinedAt: '2026-09-01T00:00:00Z', finalRank: i + 1,
        finalTier: long ? 'Gold 대한민국 특별 경쟁 등급' : 'Gold', finalReturnRate: '4.82',
      })) });
    }
    if (params.has('navigation')) {
      transport.requests.push(path);
      if (url.pathname === '/records/me/seasons/record-0') return response({
        state: 'available', season: { id: 'record-0', name: 'Season 1', status: 'active', startAt: '2026-09-01T00:00:00Z', endAt: '2099-01-01T00:00:00Z' },
        participant: { finalRank: 2, finalTier: 'Silver' },
        performance: { state: 'available', totalAssetKrw: '9648192', returnRate: '-3.52', maxDrawdown: '0' },
        activitySummary: { orders: { total: 0, submitted: 0, executed: 0, canceled: 0, rejected: 0 }, exchanges: { total: 0 }, walletTransactions: { total: 0 }, positions: { open: 7 } },
        profitAnalysis: { state: 'available', totalRealizedPnlKrw: '0', totalUnrealizedPnlKrw: '0', totalPnlKrw: '0', items: [], bestAsset: null, worstAsset: null, valuationErrors: [] },
      });
      if (url.pathname === '/records/me/seasons/record-0/equity') return response({ state: 'empty', seasonId: 'record-0', points: [], pagination: pagination(0, 500, 0) });
      if (url.pathname === '/records/me/seasons/record-0/exchanges') return response({ items: [], pagination: pagination(0, 20, 0) });
      if (/^\/trading-accounts\/[^/]+\/orders$/.test(path)) return response({ state: 'available', tradingAccountId: path.split('/')[2], orders: [], pagination: pagination(0, 20, 0) });
      if (/^\/trading-accounts\/[^/]+\/wallet-transactions$/.test(path)) return response({ tradingAccountId: path.split('/')[2], filters: { currency: config?.params?.currency ?? null, direction: config?.params?.direction ?? null, txType: config?.params?.txType ?? null }, transactions: [], pagination: pagination(0, 20, 0) });
      const account = transport.accounts.find((a) => path === `/trading-accounts/${a.id}`);
      if (account) return response(account);
      if (url.pathname === '/fx/rates/current') return response({ state: 'unavailable' });
    }
    return homeClient.get(path, config);
  },
};
