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
// QUEST 01 progress as the server derives it; `quest=0|1|2|error` selects it.
const questStep = (stepId, at) => ({ stepId, completed: at !== null, completedAt: at, referenceId: at ? `${stepId}-ref` : null });
function questProgress(accountId) {
  const level = params.get('quest') ?? '0';
  if (level === 'error') throw Object.assign(new Error('Request failed with status code 503'), { response: { status: 503, data: { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Request could not be completed.' } } } });
  const count = Number(level);
  return response({ tradingAccountId: accountId, quests: [{
    questId: 'common-01-trading-funds',
    status: ['not_started', 'in_progress', 'completed'][count],
    completedStepCount: count, totalStepCount: 2,
    steps: [questStep('fx_krw_to_usd', count > 0 ? '2026-10-10T01:00:00.000Z' : null),
      questStep('transfer_securities_usd_to_crypto_spot_usd', count > 1 ? '2026-10-10T01:05:00.000Z' : null)],
  }] });
}
export const apiClient = {
  async get(path, config) {
    const quest = /^\/trading-accounts\/([^/]+)\/quests$/.exec(path);
    if (quest) {
      transport.requests.push(path);
      if (transport.questDelay) await new Promise(resolve => transport.pending.push(resolve));
      transport.responses.push(path);
      return questProgress(decodeURIComponent(quest[1]));
    }
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
