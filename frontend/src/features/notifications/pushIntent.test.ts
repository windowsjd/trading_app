import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  intentGuardName,
  parsePushData,
  PENDING_INTENT_TTL_MS,
  resolvePushIntent,
  type IntentContext,
  type PushIntent,
} from './pushIntent.ts';
import { refreshForPush } from './pushRefresh.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const fill = { v: 1, type: 'trade_fill', uid: 'user-a', accountId: 'acct-1', market: 'spot' };

function context(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    userId: 'user-a',
    mainReady: true,
    ownedAccountIds: ['acct-1', 'acct-2'],
    receivedAt: 1_000,
    now: 1_000,
    ...overrides,
  };
}

describe('push payloads', () => {
  it('maps each type to its destination', () => {
    assert.deepEqual(parsePushData(fill), {
      kind: 'trade_history',
      type: 'trade_fill',
      uid: 'user-a',
      accountId: 'acct-1',
      market: 'spot',
    });
    assert.deepEqual(
      parsePushData({ ...fill, type: 'futures_liquidation', market: 'futures' }),
      {
        kind: 'trade_history',
        type: 'futures_liquidation',
        uid: 'user-a',
        accountId: 'acct-1',
        market: 'futures',
        futuresView: 'liquidations',
      },
    );
    assert.equal(
      (parsePushData({ ...fill, market: 'futures' }) as { futuresView?: string }).futuresView,
      'executions',
    );
    assert.equal(parsePushData({ ...fill, type: 'order_failure' })?.kind, 'trade_history');
    assert.equal(parsePushData({ v: 1, type: 'friend_request', uid: 'u' })?.kind, 'friend_requests');
    assert.equal(
      parsePushData({ v: 1, type: 'important_notice', uid: 'u', noticeId: 'n-1' })?.kind,
      'notice',
    );
    for (const type of ['season_final_result', 'season_ending_soon'])
      assert.equal(parsePushData({ v: 1, type, uid: 'u', seasonId: 's-1' })?.kind, 'season_record');
  });

  it('rejects anything malformed or unknown', () => {
    for (const data of [
      null,
      'x',
      { ...fill, v: 2 },
      { ...fill, uid: undefined },
      { ...fill, accountId: '../../etc' },
      { ...fill, market: 'margin' },
      { v: 1, type: 'marketing', uid: 'u' },
      { v: 1, type: 'important_notice', uid: 'u' },
      { v: 1, type: 'season_final_result', uid: 'u', seasonId: 'a b' },
    ])
      assert.equal(parsePushData(data), null);
  });
});

describe('applying a tapped push', () => {
  const intent = parsePushData(fill) as PushIntent;

  it('waits for sign-in and the main tabs (mode choice is never skipped)', () => {
    assert.deepEqual(resolvePushIntent(intent, context({ userId: null })), { action: 'wait' });
    assert.deepEqual(resolvePushIntent(intent, context({ mainReady: false })), { action: 'wait' });
    assert.deepEqual(resolvePushIntent(intent, context({ ownedAccountIds: null })), { action: 'wait' });
  });

  it('opens only for its own user and an owned account', () => {
    assert.deepEqual(resolvePushIntent(intent, context()), { action: 'navigate', intent });
    assert.deepEqual(resolvePushIntent(intent, context({ userId: 'user-b' })), {
      action: 'discard',
      reason: 'other_user',
    });
    assert.deepEqual(resolvePushIntent(intent, context({ ownedAccountIds: ['acct-9'] })), {
      action: 'discard',
      reason: 'account_not_owned',
    });
  });

  it('drops a tap that waited too long for a sign-in', () => {
    assert.deepEqual(
      resolvePushIntent(intent, context({ now: 1_000 + PENDING_INTENT_TTL_MS + 1 })),
      { action: 'discard', reason: 'expired' },
    );
  });

  it('needs no account list for user-scoped destinations', () => {
    const notice = parsePushData({ v: 1, type: 'important_notice', uid: 'user-a', noticeId: 'n1' })!;
    assert.equal(resolvePushIntent(notice, context({ ownedAccountIds: null })).action, 'navigate');
    assert.equal(intentGuardName(notice), 'MyTab');
    assert.equal(intentGuardName(intent), 'TradeHistory');
  });
});

describe('foreground refresh', () => {
  function client() {
    const keys: string[] = [];
    return {
      keys,
      invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
        keys.push(JSON.stringify(queryKey));
      },
    };
  }

  it('refreshes only the event account and never another account', () => {
    const c = client();
    refreshForPush(c, parsePushData(fill)!, { seasonUi: false });
    assert.equal(c.keys.length > 0, true);
    assert.equal(c.keys.some((key) => key.includes('acct-2')), false);
    assert.equal(c.keys.includes(JSON.stringify(QUERY_KEYS.tradingAccount.ordersAll('acct-1'))), true);
  });

  it('refreshes futures, friends, notices and season reads for their events', () => {
    const futures = client();
    refreshForPush(futures, parsePushData({ ...fill, market: 'futures' })!, { seasonUi: false });
    assert.equal(futures.keys.includes(JSON.stringify(QUERY_KEYS.tradingAccount.futures.all('acct-1'))), true);
    const friends = client();
    refreshForPush(friends, parsePushData({ v: 1, type: 'friend_request', uid: 'u' })!, { seasonUi: false });
    assert.deepEqual(friends.keys, [JSON.stringify(QUERY_KEYS.friends.all)]);
    const notice = client();
    refreshForPush(notice, parsePushData({ v: 1, type: 'important_notice', uid: 'u', noticeId: 'n' })!, { seasonUi: false });
    assert.deepEqual(notice.keys, [JSON.stringify(QUERY_KEYS.notices.important)]);
    const season = client();
    refreshForPush(season, parsePushData({ v: 1, type: 'season_ending_soon', uid: 'u', seasonId: 's' })!, { seasonUi: false });
    assert.equal(season.keys.includes(JSON.stringify(QUERY_KEYS.record.all)), true);
  });
});
