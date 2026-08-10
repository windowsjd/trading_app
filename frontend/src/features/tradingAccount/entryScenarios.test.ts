import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveAuthedEntryRoute } from '../auth/entry.ts';
import {
  hasGeneralAccount,
  selectTradingAccountId,
  sortAccountsForDisplay,
  type SelectableAccount,
} from './accountSelection.ts';
import { buildModeSelectionModel } from './modeSelection.ts';
import { completeGeneralAccountOpen } from './generalAccountOpen.ts';
import type { OpenGeneralAccountDto, TradingAccountDto } from './api.ts';

/**
 * The release scenarios of 작업 13 §15, composed from the REAL functions the
 * screens run — entry routing, the mode-selection model, the general-open
 * completion flow, and the selection policy. There is no React renderer in
 * this project (node --test only), so this is the closest executable form of
 * the E2E flows: every decision the screens delegate is exercised end to end,
 * and only the JSX in between is trusted to call them.
 */

const NOW = new Date('2026-08-10T05:00:00.000Z');

function seasonDto(id: string, seasonId: string): TradingAccountDto {
  return {
    id,
    mode: 'season',
    status: 'active',
    initialCapitalKrw: '10000000',
    openedAt: '2026-07-01T00:00:00.000Z',
    closedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    season: {
      seasonId,
      seasonName: 'Season 1',
      seasonStatus: 'active',
      startAt: '2026-07-01T00:00:00.000Z',
      endAt: '2026-09-30T00:00:00.000Z',
      seasonParticipantId: `sp-${id}`,
      participantStatus: 'active',
      joinedAt: '2026-07-01T00:00:00.000Z',
    },
  };
}

function generalDto(id: string): TradingAccountDto {
  return {
    id,
    mode: 'general',
    status: 'active',
    initialCapitalKrw: '10000000',
    openedAt: '2026-08-10T04:59:00.000Z',
    closedAt: null,
    createdAt: '2026-08-10T04:59:00.000Z',
    updatedAt: '2026-08-10T04:59:00.000Z',
    season: null,
  };
}

/**
 * A user's slice of the backend: the owned list, and the idempotent general
 * open. Mirrors the real contract — the FIRST open creates, every replay
 * answers the same account with `created: false`, and the list only ever
 * gains ONE general account.
 */
function fakeBackend(initialAccounts: TradingAccountDto[]) {
  let accounts = [...initialAccounts];
  let openCalls = 0;

  return {
    get accounts() {
      return accounts;
    },
    get openCalls() {
      return openCalls;
    },
    async openGeneral(): Promise<OpenGeneralAccountDto> {
      openCalls += 1;
      const existing = accounts.find((account) => account.mode === 'general');

      if (existing) {
        return { created: false, account: existing, wallets: [] };
      }

      const created = generalDto('general-new');
      accounts = [...accounts, created];
      return { created: true, account: created, wallets: [] };
    },
  };
}

/** The provider-side state the flow drives: fetched list + stored choice. */
function providerState(backend: ReturnType<typeof fakeBackend>) {
  const state = {
    list: [] as TradingAccountDto[],
    selectedId: null as string | null,
    route: null as string | null,
  };

  return {
    state,
    deps: {
      refreshOwnedAccounts: async () => {
        await Promise.resolve();
        state.list = backend.accounts;
      },
      selectAccount: (accountId: string) => {
        state.selectedId = accountId;
      },
      onOpened: () => {
        state.route = 'home';
      },
    },
  };
}

function modeOf(accounts: readonly SelectableAccount[], id: string | null) {
  return accounts.find((account) => account.id === id)?.mode ?? null;
}

describe('시나리오 A — 시즌계정만 가진 사용자가 일반 투자를 시작한다 (13.1)', () => {
  it('login → mode selection → start general → general Home → switcher shows both → season Home', async () => {
    const season = seasonDto('season-acc-1', 'season-1');
    const backend = fakeBackend([season]);

    // 1–2. New login lands on mode selection, NOT season Home.
    assert.equal(
      resolveAuthedEntryRoute('new_login', backend.accounts, null),
      'mode_selection',
    );

    // 3. The screen offers BOTH: starting 일반 투자, continuing Season 1.
    const model = buildModeSelectionModel(backend.accounts, null, NOW);
    assert.deepEqual(model.general, { kind: 'start' });
    assert.deepEqual(
      model.seasonContinue.map((account) => account.id),
      ['season-acc-1'],
    );

    // 4–7. 일반 투자 선택: explicit POST → refetch → select → Home.
    const { state, deps } = providerState(backend);
    const result = await backend.openGeneral();
    await completeGeneralAccountOpen(result, deps);

    assert.equal(backend.openCalls, 1);
    assert.equal(state.selectedId, 'general-new');
    assert.equal(state.route, 'home');
    assert.equal(modeOf(state.list, state.selectedId), 'general');

    // The provider's selection policy agrees: the explicit id wins.
    assert.deepEqual(selectTradingAccountId(state.list, state.selectedId), {
      accountId: 'general-new',
      reason: 'stored',
    });

    // 8–9. The switcher now lists BOTH accounts and no longer offers a start.
    const rows = sortAccountsForDisplay(state.list).map((account) => account.id);
    assert.deepEqual(new Set(rows), new Set(['general-new', 'season-acc-1']));
    assert.equal(hasGeneralAccount(state.list), true);

    // 10–11. Switching back to Season 1 is a plain selection.
    deps.selectAccount('season-acc-1');
    assert.equal(modeOf(state.list, state.selectedId), 'season');
  });

  it('a double press cannot create a second account: the replay lands on the SAME general account', async () => {
    const backend = fakeBackend([seasonDto('season-acc-1', 'season-1')]);
    const { state, deps } = providerState(backend);

    // Two presses that both reached the server (the UI additionally guards
    // with isPending; the contract holds even without it).
    await completeGeneralAccountOpen(await backend.openGeneral(), deps);
    await completeGeneralAccountOpen(await backend.openGeneral(), deps);

    assert.equal(backend.openCalls, 2);
    const generals = backend.accounts.filter(
      (account) => account.mode === 'general',
    );
    assert.equal(generals.length, 1);
    assert.equal(state.selectedId, 'general-new');
  });
});

describe('시나리오 B·C — general+season 보유 사용자의 새 로그인 (13.3)', () => {
  const general = generalDto('general-acc-1');
  const season = seasonDto('season-acc-1', 'season-1');
  const accounts = [general, season];

  it('never auto-enters Home: the route is mode selection even with a stored choice', () => {
    assert.equal(
      resolveAuthedEntryRoute('new_login', accounts, 'season-acc-1'),
      'mode_selection',
    );
  });

  it('B: choosing 시즌 투자 lands on the season account', () => {
    const model = buildModeSelectionModel(accounts, null, NOW);
    assert.equal(model.general.kind, 'existing');
    assert.deepEqual(
      model.seasonContinue.map((account) => account.id),
      ['season-acc-1'],
    );

    // The press is a plain selection of an EXISTING account — no POST exists
    // in this path at all.
    assert.deepEqual(selectTradingAccountId(accounts, 'season-acc-1'), {
      accountId: 'season-acc-1',
      reason: 'stored',
    });
    assert.equal(modeOf(accounts, 'season-acc-1'), 'season');
  });

  it('C: choosing 일반 투자 lands on the existing general account without creating one', async () => {
    const backend = fakeBackend(accounts);
    const model = buildModeSelectionModel(backend.accounts, null, NOW);

    assert.equal(
      model.general.kind === 'existing' ? model.general.account.id : null,
      'general-acc-1',
    );

    // The screen selects the existing account directly; the backend sees no
    // open call.
    assert.deepEqual(selectTradingAccountId(backend.accounts, 'general-acc-1'), {
      accountId: 'general-acc-1',
      reason: 'stored',
    });
    assert.equal(backend.openCalls, 0);
  });
});
