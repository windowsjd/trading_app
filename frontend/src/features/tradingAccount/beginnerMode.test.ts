import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getTradingAccountCapabilities } from './capabilities.ts';
import { getAccountDisplay } from './accountDisplay.ts';
import { selectTradingAccountId } from './accountSelection.ts';
import { resolveAccountBinding } from './accountBinding.ts';
import { assertDailyEquity } from './dailyEquity.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { getLedgerTypeFilters } from '../wallet/transactions.ts';
import type { TradingAccountDto } from './api';

const beginner: TradingAccountDto = { id: 'beginner', mode: 'beginner', status: 'active', season: null,
  initialCapitalKrw: '10000000', openedAt: '2026-10-09T00:00:00.000Z', closedAt: null,
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' };
const general = { ...beginner, id: 'general', mode: 'general' as const };

it('beginner is a separately named TWR account without season or ad reward capabilities', () => {
  const caps = getTradingAccountCapabilities(beginner)!;
  assert.equal(getAccountDisplay(beginner).title, '초보 투자');
  assert.equal(caps.returnRateMethod, 'time_weighted');
  assert.equal(caps.isGeneral, false);
  assert.equal(caps.showsSeasonUi, false);
  assert.equal(caps.canClaimAdReward, false);
  assert.equal(caps.canTrade, true); // Beginner uses the same standalone financial capabilities.
  assert.equal(caps.canExchange, true);
  assert.equal(getLedgerTypeFilters('all', 'beginner', 'KRW').some(row => row.key === 'ad_reward'), false);
  const closed = getTradingAccountCapabilities({ ...beginner, status: 'closed' })!;
  assert.equal(closed.canTrade, false);
  assert.equal(closed.canExchange, false);
  assert.equal(closed.canCancelOrder, true);
});

it('stored beginner selection and switching to general retain distinct financial query/flow scopes', () => {
  const accounts = [beginner, general];
  assert.equal(selectTradingAccountId(accounts, beginner.id).accountId, beginner.id);
  assert.equal(selectTradingAccountId(accounts, general.id).accountId, general.id);
  assert.notDeepEqual(QUERY_KEYS.tradingAccount.portfolio(beginner.id), QUERY_KEYS.tradingAccount.portfolio(general.id));
  assert.equal(resolveAccountBinding({ accounts, boundAccountId: beginner.id, selectedAccountId: general.id, accountsLoading: false }).state, 'account_changed');
});

it('beginner daily history requires TWR semantics and rejects foreign account data', () => {
  const data = { tradingAccountId: beginner.id, mode: 'beginner', granularity: 'daily', range: '30d', state: 'available', returnRateMethod: 'time_weighted',
    points: [{ snapshotDate: '2026-10-09', time: '2026-10-09T01:00:00.000Z', totalAssetKrw: '10000000', returnRate: '0', returnRateMethod: 'time_weighted', snapshotReason: 'scheduled', externalFundingAmountKrw: null, cumulativeExternalFundingKrw: '10000000', investmentPnlKrw: '0' }] };
  assert.equal(assertDailyEquity(data, '30d', beginner.id).points.length, 1);
  assert.throws(() => assertDailyEquity(data, '30d', general.id));
  assert.throws(() => assertDailyEquity({ ...data, returnRateMethod: 'initial_capital' }, '30d', beginner.id));
});
