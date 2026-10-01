// The production screens, query observers and API mappers run unchanged.
// REST/WebSocket transport and navigation are the browser fixture boundaries.
import { apiClient as homeClient, navigation, transport } from './homeMocks';
export { navigation, transport };
export const useRootNavigation = () => navigation;
const params = new URLSearchParams(location.search);
const long = params.get('long') === '1';
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
  async get(path) {
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
    return homeClient.get(path);
  },
};
