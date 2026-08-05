import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canQuerySeasonOrders,
  resolveSeasonAccount,
} from './seasonAccountLookup.ts';
import type { TradingAccountDto } from '../tradingAccount/api';

function seasonAccount(id: string, seasonId: string): TradingAccountDto {
  return {
    id,
    mode: 'season',
    status: 'active',
    initialCapitalKrw: '10000000',
    openedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    season: {
      seasonId,
      seasonName: '2026 상반기 모의투자 리그 시즌',
      seasonStatus: 'active',
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-06-30T00:00:00.000Z',
      seasonParticipantId: `participant-${seasonId}`,
      participantStatus: 'active',
      joinedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function generalAccount(id: string): TradingAccountDto {
  return {
    ...seasonAccount(id, 'unused'),
    mode: 'general',
    season: null,
  };
}

describe('season account lookup for the record order list', () => {
  it('is loading while the account list is loading', () => {
    const lookup = resolveSeasonAccount({
      seasonId: 'season-1',
      accounts: [],
      isLoading: true,
      isError: false,
    });

    assert.equal(lookup.state, 'loading');
    assert.equal(canQuerySeasonOrders(lookup), false);
  });

  it('reports an account LIST failure separately from a missing account', () => {
    const lookup = resolveSeasonAccount({
      seasonId: 'season-1',
      accounts: [],
      isLoading: false,
      isError: true,
    });

    // The retry the screen offers for this state is refetchAccounts(), not the
    // orders query — which is disabled and would do nothing.
    assert.equal(lookup.state, 'account_list_error');
    assert.equal(canQuerySeasonOrders(lookup), false);
  });

  it('reports a genuinely missing season account when the list loaded fine', () => {
    const lookup = resolveSeasonAccount({
      seasonId: 'season-1',
      accounts: [generalAccount('acc-general'), seasonAccount('acc-2', 'season-2')],
      isLoading: false,
      isError: false,
    });

    // NOT an empty order list: that would claim the user made no trades.
    assert.equal(lookup.state, 'account_missing');
    assert.equal(canQuerySeasonOrders(lookup), false);
  });

  it('resolves the account for the season the screen is about', () => {
    const account = seasonAccount('acc-1', 'season-1');
    const lookup = resolveSeasonAccount({
      seasonId: 'season-1',
      accounts: [generalAccount('acc-general'), account, seasonAccount('acc-2', 'season-2')],
      isLoading: false,
      isError: false,
    });

    assert.equal(lookup.state, 'ready');
    assert.equal(lookup.account?.id, 'acc-1');
    assert.equal(canQuerySeasonOrders(lookup), true);
  });

  it('never matches a general account to a season', () => {
    const lookup = resolveSeasonAccount({
      seasonId: 'season-1',
      accounts: [generalAccount('acc-general')],
      isLoading: false,
      isError: false,
    });

    assert.equal(lookup.state, 'account_missing');
  });

  it('prefers the cached list over a failed background refetch', () => {
    // react-query reports isError from a failed refresh while still holding a
    // good list. The list is the answer; the orders query stays enabled.
    const lookup = resolveSeasonAccount({
      seasonId: 'season-1',
      accounts: [seasonAccount('acc-1', 'season-1')],
      isLoading: false,
      isError: true,
    });

    assert.equal(lookup.state, 'ready');
    assert.equal(canQuerySeasonOrders(lookup), true);
  });

  it('never enables the orders query with an empty account id', () => {
    const broken = { ...seasonAccount('acc-1', 'season-1'), id: '' };
    const lookup = resolveSeasonAccount({
      seasonId: 'season-1',
      accounts: [broken],
      isLoading: false,
      isError: false,
    });

    assert.equal(lookup.state, 'ready');
    // A blank id would produce `/trading-accounts//orders`, which can only 404.
    assert.equal(canQuerySeasonOrders(lookup), false);
  });
});
