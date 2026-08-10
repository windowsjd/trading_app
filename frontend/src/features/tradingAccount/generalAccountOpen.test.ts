import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OpenGeneralAccountDto } from './api.ts';
import { completeGeneralAccountOpen } from './generalAccountOpen.ts';

/**
 * The order after `POST /trading-accounts/general` succeeded (작업 13 §11):
 * refetch the list, select the RETURNED id, then hand back to the caller.
 * Selecting before the list refresh completes would point the selection at an
 * account the provider cannot see, and the fallback would land elsewhere.
 */

function openResult(created: boolean): OpenGeneralAccountDto {
  return {
    created,
    account: {
      id: 'general-1',
      mode: 'general',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: '2026-08-01T00:00:00.000Z',
      closedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      season: null,
    },
    wallets: [],
  };
}

describe('completeGeneralAccountOpen', () => {
  it('refreshes the list BEFORE selecting, and selects before onOpened', async () => {
    const events: string[] = [];

    await completeGeneralAccountOpen(openResult(true), {
      refreshOwnedAccounts: async () => {
        // Force a real async boundary: if select ran without awaiting this,
        // the order below would flip.
        await Promise.resolve();
        events.push('refresh');
      },
      selectAccount: (accountId) => {
        events.push(`select:${accountId}`);
      },
      onOpened: (account) => {
        events.push(`opened:${account.id}`);
      },
    });

    assert.deepEqual(events, ['refresh', 'select:general-1', 'opened:general-1']);
  });

  it('selects the id THE SERVER returned — a replay (created:false) lands on the same account', async () => {
    const selected: string[] = [];

    const account = await completeGeneralAccountOpen(openResult(false), {
      refreshOwnedAccounts: async () => undefined,
      selectAccount: (accountId) => selected.push(accountId),
    });

    assert.deepEqual(selected, ['general-1']);
    assert.equal(account.id, 'general-1');
  });

  it('does not select anything when the refresh throws', async () => {
    const selected: string[] = [];

    await assert.rejects(
      completeGeneralAccountOpen(openResult(true), {
        refreshOwnedAccounts: async () => {
          throw new Error('refetch failed');
        },
        selectAccount: (accountId) => selected.push(accountId),
      }),
      /refetch failed/,
    );

    assert.deepEqual(selected, []);
  });
});
