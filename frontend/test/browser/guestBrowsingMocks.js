// Read-only transport for guest browsing (「로그인 없이 둘러보기」, 2026-10-30).
// `?guestTypes=crypto` is the server's GUEST_MARKET_DATA_ASSET_TYPES (default
// none): other markets answer 401, as the server does. Never imported by the app.
import { apiClient as tradingClient, assets, useAssetTicker, useAssetCandle, useAssetOrderBook, useFuturesOrderBook } from './tradingMocks';
import { useMarketTickers } from './rootTabsMocks';
export { useMarketTickers, useAssetTicker, useAssetCandle, useAssetOrderBook, useFuturesOrderBook };
export const getRequestGeneration = () => 0;
const guestTypes = new Set((new URLSearchParams(location.search).get('guestTypes') ?? '').split(',').filter(Boolean));
// public: sent without credentials; credentialed: the app's session-bound reads
// (in the app they fail on the device once browsing ended the session).
export const guestLog = { public: [], refused: [], credentialed: [] };
globalThis.guestLog = guestLog;
const unauthorized = () => Object.assign(new Error('401'), {
  isAxiosError: true, response: { status: 401, data: { success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } } },
});
export const apiClient = {
  async get(path, config) {
    if (!config?.skipSessionAuth) {
      guestLog.credentialed.push(path);
      throw unauthorized();
    }
    guestLog.public.push(path);
    const url = new URL(path, 'http://fixture.invalid');
    const allowed = url.pathname === '/assets'
      ? (url.searchParams.get('assetType') ? guestTypes.has(url.searchParams.get('assetType')) : guestTypes.size > 0)
      : guestTypes.has(assets.find((asset) => asset.id === decodeURIComponent(url.pathname.split('/')[2]))?.assetType);
    if (!allowed) {
      guestLog.refused.push(path);
      throw unauthorized();
    }
    const result = await tradingClient.get(path, config);
    // HOT ranks by turnover, which the shared trading fixture leaves out.
    if (url.pathname === '/assets') {
      result.data.data.assets = result.data.data.assets.map((asset, index) => ({
        ...asset, turnover: asset.turnover ?? String(9_000_000 - index * 100_000), turnoverPeriod: asset.turnoverPeriod ?? 'rolling_24h',
      }));
    }
    return result;
  },
  async post(path) {
    guestLog.credentialed.push(path);
    throw unauthorized();
  },
};
