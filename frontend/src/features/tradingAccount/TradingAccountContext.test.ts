import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';
import type { TradingAccountContextValue } from './TradingAccountContext';
import type { TradingAccountDto } from './api.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { load } = require('../../../test/ledgerTestHarness.cjs');

// Execute the real provider and capability helper. Only native hook scheduling,
// account fetching and preference storage are replaced, as in existing harnesses.
function harness(account: TradingAccountDto) {
  const state: unknown[] = [];
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  let stateIndex = 0,
    effectIndex = 0,
    queryIndex = 0,
    stateUpdates = 0;
  let pending: Array<() => void> = [];
  const h = { account };
  const provider = load(
    resolve('src/features/tradingAccount/TradingAccountContext.tsx'),
    {
      react: {
        ...React,
        useState: (initial: unknown) => {
          const i = stateIndex++;
          if (!(i in state))
            state[i] = typeof initial === 'function' ? initial() : initial;
          return [
            state[i],
            (value: unknown) => {
              stateUpdates++;
              state[i] = typeof value === 'function' ? value(state[i]) : value;
            },
          ];
        },
        useCallback: (fn: unknown) => fn,
        useMemo: (fn: () => unknown) => fn(),
        useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
          const i = effectIndex++,
            previous = effects[i];
          if (
            previous &&
            deps.every((value, index) => Object.is(value, previous.deps[index]))
          )
            return;
          pending.push(() => {
            previous?.cleanup?.();
            effects[i] = { deps, cleanup: fn() };
          });
        },
      },
      '@tanstack/react-query': {
        useQueryClient: () => ({ cancelQueries: async () => {} }),
        useQuery: () => ({
          data:
            queryIndex++ === 0 ? { id: 'user-1' } : { accounts: [h.account] },
          isLoading: false,
          isError: false,
          refetch: async () => ({}),
        }),
      },
      '../me/api': { getMe: async () => ({}) },
      './api': { getTradingAccounts: async () => ({}) },
      './selectionStorage': {
        readSelectedAccountId: async () => null,
        writeSelectedAccountId: async () => {},
        clearSelectedAccountId: async () => {},
      },
    },
  ).TradingAccountProvider;
  return {
    updateCount: () => stateUpdates,
    setAccount: (next: TradingAccountDto) => {
      h.account = next;
    },
    render: () => {
      stateIndex = effectIndex = queryIndex = 0;
      pending = [];
      const result = provider({ children: null });
      pending.forEach((fn) => fn());
      return result.props.value as TradingAccountContextValue;
    },
    dispose: () => effects.forEach((effect) => effect.cleanup?.()),
  };
}

const start = Date.parse('2026-09-01T00:00:00Z');
const account: TradingAccountDto = {
  id: 'season-account',
  mode: 'season',
  status: 'active',
  initialCapitalKrw: '10000000',
  openedAt: new Date(start).toISOString(),
  closedAt: null,
  createdAt: new Date(start).toISOString(),
  updatedAt: new Date(start).toISOString(),
  season: {
    seasonId: 'season',
    seasonName: 'test season',
    seasonStatus: 'active',
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + 1000).toISOString(),
    seasonParticipantId: 'participant',
    participantStatus: 'active',
    joinedAt: new Date(start).toISOString(),
  },
};

it('updates selected-account CTA capability at start and end without a network response', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start - 1 });
  const h = harness(account);
  t.after(h.dispose);
  assert.equal(h.render().capabilities?.canTrade, false);
  const beforeStart = h.updateCount();
  t.mock.timers.tick(1);
  assert.ok(h.updateCount() > beforeStart, 'start timer requests a render');
  assert.equal(h.render().capabilities?.canTrade, true);
  const beforeEnd = h.updateCount();
  t.mock.timers.tick(1000);
  assert.ok(h.updateCount() > beforeEnd, 'end timer requests a render');
  const caps = h.render().capabilities!;
  assert.equal(caps.canTrade, false);
  assert.equal(caps.canQuote, false);
  assert.equal(caps.canExchange, false);
  assert.equal(caps.canRead, true);
  assert.equal(caps.canCancelOrder, true);
});

it('applies refreshed participant exclusion while keeping the same account and history', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const h = harness(account);
  t.after(h.dispose);
  assert.equal(h.render().capabilities?.canExchange, true);
  h.setAccount({
    ...account,
    season: { ...account.season!, participantStatus: 'excluded' },
  });
  const value = h.render();
  assert.equal(value.selectedAccountId, account.id);
  assert.equal(value.capabilities?.tradeBlockReason, 'participant_excluded');
  assert.equal(value.capabilities?.canExchange, false);
  assert.equal(value.capabilities?.canCancelOrder, true);
});
