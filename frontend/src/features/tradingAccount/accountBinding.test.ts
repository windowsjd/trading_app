import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveAccountBinding,
  shouldResetBoundFlow,
} from './accountBinding.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import type { TradingAccountDto } from './api.ts';

function seasonAccount(
  id: string,
  overrides: Partial<{
    status: TradingAccountDto['status'];
    seasonStatus: string;
    seasonName: string;
  }> = {},
): TradingAccountDto {
  return {
    id,
    mode: 'season',
    status: overrides.status ?? 'active',
    initialCapitalKrw: '10000000',
    openedAt: '2026-05-01T00:00:00.000Z',
    closedAt: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    season: {
      seasonId: `season-${id}`,
      seasonName: overrides.seasonName ?? `시즌 ${id}`,
      seasonStatus: (overrides.seasonStatus ?? 'active') as never,
      startAt: '2026-05-01T00:00:00.000Z',
      endAt: '2026-05-31T00:00:00.000Z',
      seasonParticipantId: `sp-${id}`,
      participantStatus: 'active',
      joinedAt: '2026-05-01T00:00:00.000Z',
    },
  };
}

function generalAccount(
  id: string,
  status: TradingAccountDto['status'] = 'active',
): TradingAccountDto {
  return {
    id,
    mode: 'general',
    status,
    initialCapitalKrw: '10000000',
    openedAt: '2026-04-01T00:00:00.000Z',
    closedAt: status === 'closed' ? '2026-06-01T00:00:00.000Z' : null,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    season: null,
  };
}

const SEASON = seasonAccount('acc-season');
const GENERAL = generalAccount('acc-general');
const ACCOUNTS = [SEASON, GENERAL];

describe('order/FX flow account binding', () => {
  it('waits while the owned-account list is still loading', () => {
    const binding = resolveAccountBinding({
      boundAccountId: SEASON.id,
      accounts: [],
      selectedAccountId: null,
      accountsLoading: true,
    });

    assert.equal(binding.state, 'loading');
    assert.equal(shouldResetBoundFlow(binding), false);
  });

  it('binds to the ROUTE account, not to the selected one', () => {
    const binding = resolveAccountBinding({
      boundAccountId: SEASON.id,
      accounts: ACCOUNTS,
      selectedAccountId: SEASON.id,
      accountsLoading: false,
    });

    assert.equal(binding.state, 'bound');
    assert.equal(binding.state === 'bound' && binding.account.id, SEASON.id);
  });

  it('STOPS the flow when the user switched accounts mid-order', () => {
    // The failure this prevents: a quote priced for the season account being
    // submitted as a create against the general account.
    const binding = resolveAccountBinding({
      boundAccountId: SEASON.id,
      accounts: ACCOUNTS,
      selectedAccountId: GENERAL.id,
      accountsLoading: false,
    });

    assert.equal(binding.state, 'account_changed');
    assert.equal(shouldResetBoundFlow(binding), true);
    assert.deepEqual(
      binding.state === 'account_changed'
        ? [binding.boundAccountId, binding.currentAccountId]
        : null,
      [SEASON.id, GENERAL.id],
    );
  });

  it('never silently follows the new selection', () => {
    const binding = resolveAccountBinding({
      boundAccountId: SEASON.id,
      accounts: ACCOUNTS,
      selectedAccountId: GENERAL.id,
      accountsLoading: false,
    });

    // There is no shape of this result that hands the caller the general
    // account while the route says season.
    assert.notEqual(binding.state, 'bound');
  });

  it('reports an unowned bound id without probing whose it is', () => {
    const binding = resolveAccountBinding({
      boundAccountId: 'someone-elses-account',
      accounts: ACCOUNTS,
      selectedAccountId: 'someone-elses-account',
      accountsLoading: false,
    });

    assert.equal(binding.state, 'unknown_account');
  });

  it('prefers "account changed" over "unknown" when the selection moved on', () => {
    // The old account may legitimately have left the list; telling the user it
    // was "not found" would be both wrong and alarming.
    const binding = resolveAccountBinding({
      boundAccountId: 'gone-account',
      accounts: ACCOUNTS,
      selectedAccountId: GENERAL.id,
      accountsLoading: false,
    });

    assert.equal(binding.state, 'account_changed');
  });

  it('does not report a change when nothing is selected yet', () => {
    const binding = resolveAccountBinding({
      boundAccountId: SEASON.id,
      accounts: ACCOUNTS,
      selectedAccountId: null,
      accountsLoading: false,
    });

    assert.equal(binding.state, 'bound');
  });
});

describe('bound-account capabilities gate the mutation, not just the button', () => {
  it('an active general account can quote and create an order', () => {
    const binding = resolveAccountBinding({
      boundAccountId: GENERAL.id,
      accounts: ACCOUNTS,
      selectedAccountId: GENERAL.id,
      accountsLoading: false,
    });

    assert.equal(binding.state, 'bound');
    if (binding.state !== 'bound') return;

    assert.equal(binding.capabilities.canTrade, true);
    assert.equal(binding.capabilities.canQuote, true);
    assert.equal(binding.capabilities.canCancelOrder, true);
    assert.equal(binding.capabilities.tradeBlockReason, null);
  });

  it('a general account cannot exchange either', () => {
    const binding = resolveAccountBinding({
      boundAccountId: GENERAL.id,
      accounts: ACCOUNTS,
      selectedAccountId: GENERAL.id,
      accountsLoading: false,
    });

    if (binding.state !== 'bound') throw new Error('expected bound');
    assert.equal(binding.capabilities.canExchange, false);
    assert.equal(
      binding.capabilities.exchangeBlockReason,
      'general_fx_not_implemented',
    );
  });

  for (const status of ['suspended', 'closed'] as const) {
    it(`a ${status} account allows reads but no new order or exchange`, () => {
      const account = seasonAccount('acc-x', { status });
      const binding = resolveAccountBinding({
        boundAccountId: account.id,
        accounts: [account],
        selectedAccountId: account.id,
        accountsLoading: false,
      });

      if (binding.state !== 'bound') throw new Error('expected bound');
      assert.equal(binding.capabilities.canRead, true);
      assert.equal(binding.capabilities.canTrade, false);
      assert.equal(binding.capabilities.canExchange, false);
      // Cancel RELEASES a reservation, so the backend allows it here and so
      // does the UI — blocking it would strand the user's own money.
      assert.equal(binding.capabilities.canCancelOrder, true);
    });
  }

  it('a season account whose season has ended cannot open new orders', () => {
    const account = seasonAccount('acc-ended', { seasonStatus: 'ended' });
    const binding = resolveAccountBinding({
      boundAccountId: account.id,
      accounts: [account],
      selectedAccountId: account.id,
      accountsLoading: false,
    });

    if (binding.state !== 'bound') throw new Error('expected bound');
    assert.equal(binding.capabilities.canTrade, false);
    assert.equal(binding.capabilities.tradeBlockReason, 'season_not_active');
  });

  it('an active season account in an active season can trade', () => {
    const binding = resolveAccountBinding({
      boundAccountId: SEASON.id,
      accounts: ACCOUNTS,
      selectedAccountId: SEASON.id,
      accountsLoading: false,
    });

    if (binding.state !== 'bound') throw new Error('expected bound');
    assert.equal(binding.capabilities.canTrade, true);
    assert.equal(binding.capabilities.canQuote, true);
    assert.equal(binding.capabilities.canExchange, true);
  });
});

describe("a slow response from account A cannot repaint account B's screen", () => {
  it('gives the two accounts different query keys for the same screen', () => {
    // This is the structural guarantee, not a race the screen has to win:
    // switching CHANGES the key, so a late response resolves into the OLD key's
    // entry. react-query has no path to hand it to the new query.
    const screenKeys = (accountId: string) => [
      QUERY_KEYS.tradingAccount.positions(accountId, {
        assetId: 'asset-1',
        limit: 20,
      }),
      QUERY_KEYS.tradingAccount.wallets(accountId),
      QUERY_KEYS.tradingAccount.portfolio(accountId),
      QUERY_KEYS.tradingAccount.orders(accountId, { limit: 20 }),
    ];

    const forA = screenKeys('acc-A');
    const forB = screenKeys('acc-B');

    forA.forEach((keyA, index) => {
      assert.notDeepEqual(
        keyA,
        forB[index],
        'the same screen must key differently per account',
      );
    });
  });

  it('keeps the accountId adjacent to the resource so prefixes stay per-account', () => {
    const key = QUERY_KEYS.tradingAccount.positions('acc-A', { limit: 20 });

    assert.equal(key[0], 'tradingAccount');
    assert.equal(key[1], 'positions');
    assert.equal(key[2], 'acc-A');
  });
});
