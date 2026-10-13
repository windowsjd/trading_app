import { useEffect } from 'react';
import { assertCurrentSession } from '../../src/services/api/sessionOwnership';
const params = new URLSearchParams(location.search);
const longName = '매우 긴 한국어 관심종목 이름 Extremely Long English Company Name '.repeat(3);
export const asset = {
  id: 'a',
  assetType: 'domestic_stock',
  name: longName,
  symbol: 'LONG-SYMBOL',
  market: 'KRX',
  isActive: true,
  priceCurrency: 'KRW',
  settlementCurrency: 'KRW',
  marketStatus: 'open',
  tradable: true,
  price: {
    state: 'available',
    currentPrice: '1234567890',
    changeRate: '123.456',
    priceCurrency: 'KRW',
  },
};
let entries =
  params.get('state') === 'empty'
    ? []
    : [
        {
          assetId: 'off-page',
          assetType: 'domestic_stock',
          name: longName,
          symbol: 'OFF-PAGE',
          market: 'KRX',
          isActive: false,
          createdAt: '2026-10-13T00:00:00Z',
        },
        {
          assetId: 'us',
          assetType: 'us_stock',
          name: 'Only US Market',
          symbol: 'US',
          market: 'NASDAQ',
          isActive: true,
          createdAt: '2026-10-13T00:00:00Z',
        },
      ];
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
const success = (data) => ({ data: { success: true, data } });
window.watchlistRequests = [];
export const apiClient = {
  async get(url, config = {}) {
    if (url === '/me') return success({ id: 'viewer', status: 'active', role: 'user' });
    if (url === '/watchlist') {
      window.watchlistRequests.push('GET');
      if (params.get('state') === 'loading') await new Promise(() => {});
      if (params.get('state') === 'error')
        throw { response: { status: 503, data: { error: { code: 'UNAVAILABLE' } } } };
      assertCurrentSession(config._sessionGeneration);
      return success({ items: [...entries] });
    }
    if (url.startsWith('/assets?'))
      return success({
        assets: [asset],
        pagination: { limit: 20, offset: 0, total: 1, returned: 1, nextOffset: null },
        priceErrors: [],
      });
    throw new Error(`Unexpected fixture GET ${url}`);
  },
  async put(url, _body, config) {
    window.watchlistRequests.push('PUT');
    await pause();
    assertCurrentSession(config._sessionGeneration);
    const assetId = decodeURIComponent(url.split('/').at(-1));
    if (!entries.some((row) => row.assetId === assetId))
      entries.unshift({ assetId, ...asset, createdAt: '2026-10-13T00:00:01Z' });
    return success({});
  },
  async delete(url, config) {
    window.watchlistRequests.push('DELETE');
    await pause();
    assertCurrentSession(config._sessionGeneration);
    entries = entries.filter((row) => row.assetId !== decodeURIComponent(url.split('/').at(-1)));
    return success({});
  },
};
export const useFocusEffect = (callback) => useEffect(callback, [callback]);
export const useIsFocused = () => true;
export const useQuestGuide = () => null;
export const useTradingGuideFacts = () => {};
export const useAdminDiagnostics = () => false;
export const useMarketTickers = () => ({
  tickersByAssetId: new Map(),
  staleAssetIds: new Set(),
  subscriptionErrorAssetIds: new Set(),
  connectionState: 'connected',
  showReconnectBanner: false,
});
