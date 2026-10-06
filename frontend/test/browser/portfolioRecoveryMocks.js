// Only Axios transport is replaced. The production interceptors, token storage,
// session ownership, entry, account provider and navigators all run unchanged.
import axios from 'axios';
import { apiClient } from '../../src/services/api/client.ts';
import { apiClient as fixtureClient, transport, useMarketTickers } from './rootTabsMocks';
export { apiClient, transport, useMarketTickers };
export { getRequestGeneration } from '../../src/services/api/client.ts';
const params = new URLSearchParams(location.search);
const user = { id: 'home-user', email: 'home@example.invalid', nickname: '김재민', role: params.get('role') ?? 'user', status: 'active' };
export const recovery = { scenario: params.get('scenario') ?? 'success', repaired: false, reads: [], failures: [], portfolioReads: 0 };
const requestId = 'c25c9d0a-220d-43eb-a939-7733f63e21bc';
const diagnostic = code => ({
  version: 1, code, httpStatus: 500, timestamp: '2026-10-06T00:00:00Z', requestId,
  domain: 'PORTFOLIO', operation: 'PORTFOLIO_VALUATION', failureStage: 'portfolio_valuation_validation',
  exception: { type: 'HttpException', message: 'Portfolio data could not be safely valued.', applicationStack: [], stack: [], truncated: false },
  evidence: { failedStep: 'portfolio_valuation_validation' }, diagnosticEvents: { events: [], truncated: false }, serverLogs: { entries: [], truncated: false }, truncated: false,
});
apiClient.defaults.adapter = async config => {
  const path = config.url;
  // Record only the presence of the expected credential; never its value.
  const authenticated = config.headers.Authorization === 'Bearer fixture-access';
  recovery.reads.push({ path, method: config.method, authenticated, time: performance.now() });
  const ok = data => ({ status: 200, statusText: 'OK', headers: {}, config, data: { success: true, data } });
  if (path === '/auth/login') return ok({ user, tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } });
  if (!authenticated) throw new axios.AxiosError('Unauthenticated fixture', 'ERR_BAD_REQUEST', config, {}, { status: 401, config, data: { success: false, error: { code: 'UNAUTHORIZED' } }, headers: {}, statusText: 'Unauthorized' });
  const portfolio = /\/portfolio$/.test(path);
  if (portfolio) {
    recovery.portfolioReads++;
    const firstTransient = ['timeout-once', 'gateway-once', 'network-once'].includes(recovery.scenario) && recovery.portfolioReads === 1;
    if (!recovery.repaired && (firstTransient || ['persistent', 'structural', 'generic500', 'ownership'].includes(recovery.scenario))) {
      if (recovery.scenario === 'timeout-once' || recovery.scenario === 'network-once') {
        const code = recovery.scenario === 'timeout-once' ? 'ECONNABORTED' : 'ERR_NETWORK';
        recovery.failures.push({ status: null, clientCode: code, serverCode: null });
        throw new axios.AxiosError('Controlled transport failure', code, config, {});
      }
      const status = recovery.scenario === 'ownership' ? 404 : ['structural', 'generic500'].includes(recovery.scenario) ? 500 : 503;
      const code = recovery.scenario === 'structural' ? 'TRADING_ACCOUNT_SCOPE_MISMATCH' : recovery.scenario === 'ownership' ? 'TRADING_ACCOUNT_NOT_FOUND' : 'INTERNAL_SERVER_ERROR';
      recovery.failures.push({ status, clientCode: 'ERR_BAD_RESPONSE', serverCode: code });
      throw new axios.AxiosError('Raw secret/provider/database must never be displayed', 'ERR_BAD_RESPONSE', config, {}, {
        status, statusText: 'Failed', config, headers: { 'x-request-id': requestId },
        data: { success: false, error: { code, message: 'Raw secret/provider/database must never be displayed',
          ...(user.role === 'admin' && recovery.scenario === 'structural' ? { diagnostic: diagnostic(code) } : {}) } },
      });
    }
  }
  const response = await fixtureClient.get(path, config);
  if (path === '/me') response.data.data = { ...response.data.data, ...user };
  if (portfolio && recovery.scenario === 'unavailable') response.data.data = { ...response.data.data, state: 'unavailable', summary: null, sectionErrors: [{ code: 'FX_RATE_STALE' }] };
  return { ...response, status: 200, statusText: 'OK', headers: {}, config };
};
