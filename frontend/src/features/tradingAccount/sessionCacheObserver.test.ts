import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { seedSessionCache } from '../auth/sessionCache.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

it('the mounted account provider reattaches to cleared/seeded me and incoming user-scoped account queries', async t => {
  const h = interactionHarness();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const accounts = user => ({ accounts: [{ id: `${user}-account`, mode: 'general', status: 'active', season: null }] });
  let currentUser = 'A', calls = 0, last;
  client.setQueryData(QUERY_KEYS.me, { id: 'A', role: 'user', status: 'active' });
  const module = h.load('src/features/tradingAccount/TradingAccountContext.tsx', {
    '../me/api': { getMe: async () => ({ id: currentUser }) },
    './api': { getTradingAccounts: async () => { calls++; return accounts(currentUser); } },
    './selectionStorage': { readSelectedAccountId: async user => `${user}-account`, writeSelectedAccountId: async () => {}, clearSelectedAccountId: async () => {} },
  });
  function Probe() { last = module.useTradingAccount(); return null; }
  const renderer = h.render(React.createElement(QueryClientProvider, { client }, React.createElement(module.TradingAccountProvider, {}, React.createElement(Probe))));
  t.after(() => { act(() => renderer.unmount()); client.clear(); });
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
  await flush(); assert.equal(last.selectedAccountId, 'A-account');
  client.setQueryData(QUERY_KEYS.tradingAccount.portfolio('A-account'), { privateFinancialData: true });
  currentUser = 'B';
  await act(async () => { await seedSessionCache(client, { id: 'B', nickname: 'B', email: 'b@example.invalid', role: 'user', status: 'active' }); });
  // Warm entry fetch shares the provider's exact user-scoped key.
  await client.fetchQuery({ queryKey: QUERY_KEYS.tradingAccount.list('B'), queryFn: async () => accounts('B'), staleTime: 30000 });
  await flush();
  assert.equal(last.isLoading, false);
  assert.equal(last.selectedAccountId, 'B-account');
  assert.equal(client.getQueryData(QUERY_KEYS.tradingAccount.portfolio('A-account')), undefined);
  assert.equal(client.getQueryData(QUERY_KEYS.tradingAccount.list('A')), undefined);
  assert.equal(client.getQueryCache().find({ queryKey: QUERY_KEYS.me }).getObserversCount(), 1);
  assert.equal(client.getQueryCache().find({ queryKey: QUERY_KEYS.tradingAccount.list('B') }).getObserversCount(), 1);
  assert.ok(calls <= 2, 'no repeated list loading or account creation');
});
