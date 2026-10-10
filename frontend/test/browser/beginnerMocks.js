// Fixture transport only. Production providers, navigators and screens are used.
import { apiClient as existing, transport } from './motionMocks';
export { useMarketTickers, useAssetTicker, useAssetCandle, useAssetOrderBook, getRequestGeneration } from './motionMocks';
const params = new URLSearchParams(location.search);
const legacyFlag = params.get('enabled');
const beginner = { ...transport.accounts.find(a => a.mode === 'general'), id: 'beginner-account', mode: 'beginner' };
if (!params.has('newBeginner')) transport.accounts.push(beginner);
transport.posts = [];
transport.responses = [];
window.beginnerFixture = transport;
const response = data => ({ data: { success: true, data } });
const money = value => Number(value).toFixed(8);
// Commits are serialized per account and stamped by the database clock on the
// server; this host's wall clock can step backwards, so keep stamps monotonic.
let lastCommit = 0;
const committedAt = () => new Date(lastCommit = Math.max(Date.now(), lastCommit + 1)).toISOString();

// QUEST 01/02 progress as the server derives it from committed rows.
// `quest=0|1|2|error` selects the starting ledger; practice POSTs below add
// rows, and only a matching command changes what this "server" proves.
const level = params.get('quest') ?? '0';
const ledger = {
  fxAt: Number(level) >= 1 ? '2026-10-10T01:00:00.000Z' : null,
  transferAt: Number(level) >= 2 ? '2026-10-10T01:05:00.000Z' : null,
  wallets: { krw: 10000000, usd: Number(level) >= 1 ? 73.82 : 0, spot: Number(level) >= 2 ? 10 : 0, futures: 0 },
};
transport.ledger = ledger;
const quest = (questId, stepId, at) => ({
  questId, status: at ? 'completed' : 'not_started', completedStepCount: at ? 1 : 0, totalStepCount: 1,
  steps: [{ stepId, completed: at !== null, completedAt: at, referenceId: at ? `${stepId}-ref` : null }],
});
function questProgress(accountId) {
  if (level === 'error' || transport.questFailures > 0) {
    if (transport.questFailures > 0) transport.questFailures -= 1;
    throw Object.assign(new Error('Request failed with status code 503'), { response: { status: 503, data: { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Request could not be completed.' } } } });
  }
  return response({ tradingAccountId: accountId, quests: [
    quest('common-01-exchange', 'fx_krw_to_usd', ledger.fxAt),
    quest('common-02-transfer', 'transfer_securities_usd_to_crypto_spot_usd', ledger.transferAt),
  ] });
}
const walletRows = accountId => [
  { id: `${accountId}:krw`, walletScope: 'securities', currencyCode: 'KRW', reservedAmount: '0', balanceAmount: String(ledger.wallets.krw) },
  { id: `${accountId}:usd`, walletScope: 'securities', currencyCode: 'USD', reservedAmount: '0', balanceAmount: ledger.wallets.usd.toFixed(2) },
  { id: `${accountId}:spot`, walletScope: 'crypto_spot', currencyCode: 'USD', reservedAmount: '0', balanceAmount: ledger.wallets.spot.toFixed(2) },
  { id: `${accountId}:futures`, walletScope: 'crypto_futures', currencyCode: 'USD', reservedAmount: '0', balanceAmount: '0' },
];
const scopeOf = walletId => walletId.endsWith(':usd') ? 'securities' : walletId.endsWith(':spot') ? 'crypto_spot' : walletId.endsWith(':futures') ? 'crypto_futures' : 'securities';
const balanceOf = walletId => walletId.endsWith(':usd') ? ledger.wallets.usd : walletId.endsWith(':spot') ? ledger.wallets.spot : walletId.endsWith(':futures') ? ledger.wallets.futures : ledger.wallets.krw;

export const apiClient = {
  async get(path, config) {
    const questMatch = /^\/trading-accounts\/([^/]+)\/quests$/.exec(path);
    if (questMatch) {
      transport.requests.push(path);
      if (transport.questDelay) await new Promise(resolve => transport.pending.push(resolve));
      transport.responses.push(path);
      return questProgress(decodeURIComponent(questMatch[1]));
    }
    if (path === '/trading-accounts') {
      transport.requests.push(path);
      // Exercise compatibility with legacy missing/false availability fields.
      return response({ accounts: transport.accounts.map(account => ({ ...account })), ...(legacyFlag === null ? {} : { beginnerModeEnabled: legacyFlag !== '0' }) });
    }
    if (params.has('practice') && path === '/trading-accounts/beginner-account/wallets') {
      transport.requests.push(path);
      transport.responses.push(path);
      return response({ tradingAccountId: 'beginner-account', wallets: walletRows('beginner-account') });
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
  async post(path, body) {
    transport.posts.push(path);
    if (path === '/trading-accounts/beginner') {
      const created = !transport.accounts.some(a => a.mode === 'beginner');
      if (created) transport.accounts.push(beginner);
      return response({ created, account: beginner, wallets: [] });
    }
    if (!params.has('practice')) throw Error('Unexpected fixture mutation');
    const accountId = path.split('/')[2];
    if (path.endsWith('/fx/quote')) {
      const rate = 1350;
      const gross = body.fromCurrency === 'KRW' ? Number(body.sourceAmount) / rate : Number(body.sourceAmount) * rate;
      transport.fxQuote = { tradingAccountId: accountId, quoteId: `fixture-fx-quote-${transport.posts.length}`, fromCurrency: body.fromCurrency,
        toCurrency: body.toCurrency, sourceAmount: body.sourceAmount, appliedRate: money(rate), feeRate: '0.001000',
        feeAmount: money(gross * 0.001), feeCurrency: body.toCurrency, grossTargetAmount: money(gross), netTargetAmount: money(gross * 0.999),
        expiresAt: new Date(Date.now() + 15000).toISOString() };
      return response(transport.fxQuote);
    }
    if (path.endsWith('/fx/execute')) {
      const quoteRow = transport.fxQuote;
      const net = Number(quoteRow.netTargetAmount);
      const executedAt = committedAt();
      if (quoteRow.fromCurrency === 'KRW') {
        ledger.wallets.krw -= Number(quoteRow.sourceAmount); ledger.wallets.usd += net;
        ledger.fxAt ??= executedAt;
      } else {
        ledger.wallets.usd -= Number(quoteRow.sourceAmount); ledger.wallets.krw += net;
      }
      return response({ ...quoteRow, exchangeId: `fixture-exchange-${transport.posts.length}`, quotedRate: quoteRow.appliedRate,
        executeRate: quoteRow.appliedRate, rateChangeBps: '0', executedAt,
        wallets: { KRW: String(ledger.wallets.krw), USD: ledger.wallets.usd.toFixed(2) } });
    }
    if (path.endsWith('/wallet-transfers')) {
      const amount = Number(body.amount);
      const source = scopeOf(body.sourceWalletId), destination = scopeOf(body.destinationWalletId);
      const key = scope => scope === 'securities' ? 'usd' : scope === 'crypto_spot' ? 'spot' : 'futures';
      ledger.wallets[key(source)] -= amount; ledger.wallets[key(destination)] += amount;
      const executedAt = committedAt();
      if (source === 'securities' && destination === 'crypto_spot' && ledger.fxAt) ledger.transferAt ??= executedAt;
      const wallet = id => ({ walletId: id, walletScope: scopeOf(id), balanceAfter: money(balanceOf(id)), availableAfter: money(balanceOf(id)) });
      return response({ tradingAccountId: accountId, transferId: `fixture-transfer-${transport.posts.length}`, currencyCode: 'USD',
        amount: money(amount), executedAt, source: wallet(body.sourceWalletId), destination: wallet(body.destinationWalletId) });
    }
    throw Error('Unexpected fixture mutation');
  },
};
