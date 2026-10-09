// Fixture transport only. Production providers, navigators and screens are used.
import { apiClient as existing, transport } from './motionMocks';
export { useMarketTickers, useAssetTicker, useAssetCandle, useAssetOrderBook, getRequestGeneration } from './motionMocks';
const params = new URLSearchParams(location.search);
const enabled = params.get('enabled') !== '0';
const beginner = { ...transport.accounts.find(a => a.mode === 'general'), id: 'beginner-account', mode: 'beginner' };
if (!params.has('newBeginner')) transport.accounts.push(beginner);
transport.posts = [];
transport.responses = [];
window.beginnerFixture = transport;
const response = data => ({ data: { success: true, data } });
export const apiClient = {
  async get(path, config) {
    if (path === '/trading-accounts') {
      transport.requests.push(path);
      // Include a cached beginner even when disabled to exercise the client guard.
      return response({ accounts: transport.accounts.map(account => ({ ...account })), beginnerModeEnabled: enabled });
    }
    const result = await existing.get(path, config);
    if (path === '/trading-accounts/beginner-account/portfolio') {
      result.data.data.summary = { ...result.data.data.summary,
        totalAssetKrw: '10000000', returnRate: '0', initialFundingKrw: '10000000',
        cumulativeExternalFundingKrw: '10000000', investmentPnlKrw: '0', unrealizedPnlKrw: '0' };
    }
    transport.responses.push(path);
    return result;
  },
  async post(path) {
    transport.posts.push(path);
    if (path !== '/trading-accounts/beginner' || !enabled) throw Error('Unexpected fixture mutation');
    const created = !transport.accounts.some(a => a.mode === 'beginner');
    if (created) transport.accounts.push(beginner);
    return response({ created, account: beginner, wallets: [] });
  },
};
