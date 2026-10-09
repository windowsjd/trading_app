import { useEffect } from 'react';
import { futuresFixture } from '../futuresFixtures.cjs';
export const useFocusEffect = (callback) => useEffect(callback, [callback]);
export const useIsFocused = () => true;
export const useLogout = () => async () => {};
const params = new URLSearchParams(location.search);
const user = {
  userId: 'friend',
  nickname: '아주긴친구닉네임LongNickname'.repeat(5),
  profileImageUrl: null,
  relationship: 'friend',
  requestId: 'friendship',
  active: true,
};
const me = { id: 'viewer', nickname: '내닉네임', portfolioPublic: true };
const summary = {
  state: 'available',
  user: { id: user.userId, nickname: user.nickname, profileImageUrl: null },
  season: {
    id: 'season',
    name: '현재 시즌',
    status: 'active',
    rank: 37,
    provisionalTier: 'gold',
    finalTier: null,
    totalAssetKrw: '1234567890',
    returnRate: '123.123',
    maxDrawdown: '5',
    percentile: '10',
    totalFillCount: 1,
  },
  portfolioAccess: params.get('access') ?? 'available',
  portfolio: {
    valuationState: 'available',
    allocation: {
      cashKrwValue: '1234567890',
      domesticStockValueKrw: '0',
      usStockValueKrw: '0',
      cryptoValueKrw: '0',
    },
    holdings: [
      {
        assetId: 'asset',
        name: '긴보유종목이름LongAssetName'.repeat(4),
        symbol: 'BTCUSDT',
        assetType: 'crypto',
        market: 'BINANCE', currencyCode: 'USD', quantity: '0.00000001',
        valuation: { state: 'available', priceCurrency: 'USD', positionValue: '1234567890123.45',
          unrealizedPnl: '-1234567890.12', returnRate: '-12.1234' },
        weight: '33.3333',
      },
    ],
    history: [
      {
        date: '2026-09-29',
        totalAssetKrw: '1234567890',
        returnRate: '123.123',
      },
    ],
  },
};
if (summary.portfolioAccess !== 'available') summary.portfolio = null;
let relation = 'none';
function response(data) {
  return { data: { success: true, data } };
}
export const apiClient = {
  get: async (path) => {
    if (path === '/me') return response({ ...me });
    if (path.includes('season-summary')) {
      const own = futuresFixture('friend', { position: true, direction: 'short', marginMode: 'cross' }).positions;
      return response({ ...summary, portfolio: summary.portfolio ? { ...summary.portfolio, futures: {
        evaluatedAt: own.evaluatedAt, positions: own.positions.map(p => ({ ...p.instrument.underlying,
          direction: p.direction, marginMode: p.marginMode, leverage: p.leverage,
          markNotional: p.markNotional, markUnrealizedPnl: p.markUnrealizedPnl, roi: p.roi,
          markState: p.markState, markEvidence: p.markEvidence })) } } : null });
    }
    const users = path.includes('/search')
      ? new URL(path, location.origin).searchParams.get('nickname') === '없는친구' ? [] : [{ ...user, relationship: relation }]
      : path.includes('/requests')
        ? [{ ...user, relationship: 'received' }]
        : [user];
    return response({
      users,
      pagination: {
        limit: 30,
        offset: 0,
        total: users.length,
        returned: users.length,
        nextOffset: null,
      },
    });
  },
  patch: async (_path, data) => {
    Object.assign(me, data);
    return response({ ...me });
  },
  post: async () => {
    relation = 'sent';
    return response({});
  },
  delete: async () => response({}),
};
