import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import axios from 'axios';
import { portfolioReadPolicy, portfolioFailureFacts, isTransientPortfolioError } from './portfolioReadPolicy.ts';
import { TradingAccountScopeMismatchError } from './accountScope.ts';
const require = createRequire(import.meta.url);
const { createSessionHarness } = require('../../../test/sessionTestHarness.cjs');
const failure = (status: number, code: string | null, config?: any) => new axios.AxiosError('sensitive raw provider/DB/token text', 'ERR_BAD_RESPONSE', config, {}, {
  status, data: { success: false, error: { code } }, headers: { 'x-request-id': 'c25c9d0a-220d-43eb-a939-7733f63e21bc' }, statusText: 'Failed', config,
} as any);
const timeout = () => new axios.AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED', undefined, {});

describe('portfolio recovery eligibility and safe facts', () => {
  for (const error of [timeout(), new axios.AxiosError('network error', 'ERR_NETWORK', undefined, {}), failure(502, null), failure(503, 'INTERNAL_SERVER_ERROR'), failure(504, 'GATEWAY_TIMEOUT')]) {
    it(`allows one bounded retry for ${portfolioFailureFacts(error).httpStatus}/${portfolioFailureFacts(error).clientCode}`, () => {
      assert.equal(isTransientPortfolioError(error), true);
      assert.equal(portfolioReadPolicy.retry(0, error), true);
      assert.equal(portfolioReadPolicy.retry(1, error), false);
    });
  }
  for (const error of [failure(401, 'UNAUTHORIZED'), failure(403, 'FORBIDDEN'), failure(404, 'TRADING_ACCOUNT_NOT_FOUND'), failure(500, 'INTERNAL_SERVER_ERROR'), failure(500, 'TRADING_ACCOUNT_SCOPE_MISMATCH'), failure(503, 'GENERAL_PERFORMANCE_INTEGRITY'), failure(503, 'INVALID_DECIMAL'), failure(503, 'NEW_INVALID_STATE'), new Error('programming error'), new axios.AxiosError('cancel', 'ERR_CANCELED'), new TradingAccountScopeMismatchError({ endpoint: 'portfolio', expectedAccountId: 'a', actualAccountId: 'b' })]) {
    it(`does not automatically retry or reconnect/remount repair ${portfolioFailureFacts(error).serverCode}/${portfolioFailureFacts(error).clientCode}`, () => {
      const state = { status: 'error', error };
      assert.equal(isTransientPortfolioError(error), false);
      assert.equal(portfolioReadPolicy.retry(0, error), false);
      assert.equal(portfolioReadPolicy.retryOnMount({ state }), false);
      assert.equal(portfolioReadPolicy.refetchOnReconnect({ state }), false);
    });
  }
  it('contains only bounded allowlisted metadata, never error messages or payloads', () => {
    const facts = portfolioFailureFacts(failure(503, 'INTERNAL_SERVER_ERROR'));
    assert.equal(facts.httpStatus, 503);
    assert.equal(facts.requestId, 'c25c9d0a-220d-43eb-a939-7733f63e21bc');
    assert.equal(facts.endpoint, 'GET /api/v1/trading-accounts/:accountId/portfolio');
    assert.equal(facts.timeout, false);
    assert.equal(portfolioFailureFacts(timeout()).timeout, true);
    assert.equal(portfolioFailureFacts(new axios.AxiosError('raw', 'ERR_NETWORK')).network, true);
    const raw = failure(500, 'accessToken=secret');
    raw.response!.headers['x-request-id'] = 'Bearer secret';
    assert.equal(portfolioFailureFacts(raw).requestId, 'not_observed');
    assert.equal(portfolioFailureFacts(raw).serverCode, 'unrecognized');
    assert.doesNotMatch(JSON.stringify(facts), /sensitive|provider|token|balance|database/iu);
  });
});

describe('actual authentication, entry, Axios and portfolio cache flow', () => {
  for (const initialFailure of [null, 'timeout', 'gateway'] as const) it(`login → seeded me → owned list → season portfolio (${initialFailure ?? 'success'})`, async t => {
    const h = createSessionHarness(); t.after(h.close);
    const api = h.load('src/features/tradingAccount/api.ts');
    const entry = h.load('src/features/auth/entry.ts');
    const install = h.block('tokens.set');
    let reads = 0;
    h.setTransport(async (config: any) => {
      if (config.url === '/auth/login') return h.ok(config, { user: h.user('A'), tokens: h.credentials('A') });
      assert.equal(config.headers.Authorization, 'Bearer A-access');
      assert.equal(h.owner.canUseSessionCredentials(config._sessionGeneration), true);
      if (config.url === '/trading-accounts') return h.ok(config, { accounts: [{ id: 'season-A', mode: 'season', status: 'active', season: { seasonStatus: 'active', participantStatus: 'active' } }] });
      if (config.url === '/trading-accounts/season-A/portfolio') {
        if (++reads === 1 && initialFailure === 'timeout') throw new axios.AxiosError('timeout', 'ECONNABORTED', config, {});
        if (reads === 1 && initialFailure === 'gateway') throw failure(503, 'INTERNAL_SERVER_ERROR', config);
        return h.ok(config, { tradingAccountId: 'season-A', state: 'available', summary: { totalAssetKrw: '10000000' } });
      }
      throw new Error('unexpected endpoint');
    });
    const login = h.session.authenticateSession(h.queryClient, () => h.auth.login({ email: 'a@example.invalid', password: 'fixture' }));
    await install.entered.promise;
    assert.equal(h.queryClient.getQueryData(h.keys.me), undefined);
    assert.equal(h.requests.length, 1, 'no financial request while token install is pending');
    install.gate.resolve(); await login;
    assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'A');
    assert.equal(await entry.loadEntryRoute(h.queryClient, 'A', 'new_login', { loadAccounts: api.getTradingAccounts, readStoredAccountId: async () => 'season-A' }), 'mode_selection');
    const data = await h.queryClient.fetchQuery({ queryKey: h.keys.tradingAccount.portfolio('season-A'), queryFn: () => api.getTradingAccountPortfolio('season-A'), ...portfolioReadPolicy, retryDelay: 0 });
    assert.equal(data.tradingAccountId, 'season-A');
    assert.equal(reads, initialFailure ? 2 : 1);
    assert.equal(h.queryClient.getQueryData(h.keys.tradingAccount.portfolio('other')), undefined);
    assert.equal(h.requests.filter((r: any) => r.method === 'post').length, 1, 'no account creation/financial mutation');
  });
});
