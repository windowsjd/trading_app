import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const React = require('react');
const { load } = require('../../../test/ledgerTestHarness.cjs');

it('historical reads are owned and route-local without changing operating selection', () => {
  let selections = 0;
  const base = { accounts: [
    { id: 'live', mode: 'general', status: 'active', season: null },
    { id: 'past', mode: 'season', status: 'active', season: { seasonStatus: 'ended', participantStatus: 'active' } },
  ], selectedAccountId: 'live', selectAccount: () => { selections++; } };
  const Provider = load(resolve('src/features/tradingAccount/TradingAccountContext.tsx'), {
    react: { ...React, useContext: () => base },
    '@tanstack/react-query': {}, '../me/api': {}, './api': {}, './selectionStorage': {},
  }).HistoricalAccountProvider;
  const value = Provider({ accountId: 'past', children: null }).props.value;
  assert.equal(value.selectedAccountId, 'past');
  assert.equal(value.historyOnly, true);
  assert.equal(value.capabilities.canRead, true);
  for (const permission of ['canTrade', 'canQuote', 'canExchange', 'canCancelOrder', 'canClaimAdReward']) assert.equal(value.capabilities[permission], false, permission);
  assert.equal(base.selectedAccountId, 'live');
  assert.equal(selections, 0);
  assert.equal(Provider({ accountId: 'not-owned', children: null }).props.value.selectedAccountId, null);
  assert.equal(Provider({ accountId: 'live', children: null }).props.value.selectedAccountId, null);
});
