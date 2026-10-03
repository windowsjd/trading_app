// Deterministic, read-only transport. Never imported by the application.
import { apiClient as rootClient, transport, useMarketTickers } from './rootTabsMocks';
import { apiClient as tradingClient, assets, useAssetTicker, useAssetCandle, useAssetOrderBook } from './tradingMocks';
export { transport, useMarketTickers, useAssetTicker, useAssetCandle, useAssetOrderBook };
export const getRequestGeneration = () => 0;
export const timing = { delay: 0, requests: [] };
const response = data => ({ data: { success: true, data } });
export const apiClient = {
  async get(path, config) {
    const sample = { path, start: performance.now(), response: null };
    timing.requests.push(sample);
    if (timing.delay) await new Promise(resolve => setTimeout(resolve, timing.delay));
    let result;
    if (/^\/assets\/[^/]+/.test(path)) {
      const id = decodeURIComponent(path.split('/')[2]);
      const original = assets.find(a => a.id === id);
      const mapped = path.replace(`/assets/${encodeURIComponent(id)}`, '/assets/BTC');
      result = await tradingClient.get(original ? path : mapped, config);
      if (result.data.data.asset && !original) result = response({ asset: { ...result.data.data.asset, id } });
    } else if (path.startsWith('/fx/rates/current') && new URLSearchParams(location.search).get('fxState') === 'available') {
      result = response({ state: 'available', pair: 'USD/KRW', baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1350', capturedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60000).toISOString(), fallbackUsed: false });
    } else if (/^\/trading-accounts\/[^/]+$/.test(path)) {
      result = response({ ...transport.accounts.find(a => a.id === path.split('/')[2]), feePolicy: { tradeFeeRate: '0.001', fxFeeRate: '0.001' } });
    } else result = await rootClient.get(path, config);
    sample.response = performance.now();
    return result;
  },
  async post() { throw Error('Financial mutations are outside the motion fixture'); },
};
