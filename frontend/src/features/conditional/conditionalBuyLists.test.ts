import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConditionalBuyListContractError,
  assertEndedConditionalBuyPage,
  getOpenConditionalBuyOrders,
  isOpenConditionalBuy,
  mergeConditionalBuyLists,
} from './conditionalBuyLists.ts';

type Row = { id: string; state: string };
const capabilities = { enabled: true, canCreate: true, canCancel: true, canUseLimit: true, markets: ['KRX'], maxLivePerAccount: 20 };
const row = (id: string, state = 'watching') => ({ id, state }) as unknown as Row;
const page = (accountId: string, rows: Row[], offset: number, total: number, limit = 100) => ({
  tradingAccountId: accountId,
  capabilities,
  conditionalOrders: rows,
  pagination: { limit, offset, total, returned: rows.length, nextOffset: offset + rows.length < total ? offset + rows.length : null },
});
/** A fake server over a fixed open set; `before` may mutate it between pages. */
function server(open: Row[], options: { before?: (offset: number) => void; account?: string } = {}) {
  const reads: unknown[] = [];
  const fetchPage = (async (accountId: string, params: { state?: string; limit?: number; offset?: number }) => {
    reads.push(params);
    const offset = params.offset ?? 0;
    options.before?.(offset);
    return page(options.account ?? accountId, open.slice(offset, offset + (params.limit ?? 100)), offset, open.length, params.limit);
  }) as never;
  return { fetchPage, reads };
}
async function failure(work: Promise<unknown>) {
  try {
    await work;
    return 'RESOLVED';
  } catch (error) {
    return error instanceof ConditionalBuyListContractError ? 'CONTRACT' : 'OTHER';
  }
}

describe('open Conditional BUY read (every page)', () => {
  it('reads every row the owner can still cancel across pages, in server order', async () => {
    const open = Array.from({ length: 150 }, (_, i) => row(`w${i}`, ['watching', 'triggered', 'order_pending'][i % 3]));
    const s = server(open);
    const result = await getOpenConditionalBuyOrders('acct', s.fetchPage);
    assert.equal(result.conditionalOrders.length, 150);
    assert.equal(result.conditionalOrders[149].id, 'w149');
    assert.equal(result.tradingAccountId, 'acct');
    assert.deepEqual(s.reads, [{ state: 'open', limit: 100, offset: 0 }, { state: 'open', limit: 100, offset: 100 }]);
  });

  it('one request when everything fits a page (the usual case)', async () => {
    const s = server([row('a'), row('b', 'order_pending')]);
    const result = await getOpenConditionalBuyOrders('acct', s.fetchPage);
    assert.equal(result.conditionalOrders.length, 2);
    assert.equal(s.reads.length, 1);
  });

  it('a set that shifted between pages fails the read instead of showing a partial list', async () => {
    const open = Array.from({ length: 120 }, (_, i) => row(`w${i}`));
    // A row ends while the second page is read: total changes.
    const s = server(open, { before: (offset) => { if (offset === 100) open.splice(0, 1); } });
    assert.equal(await failure(getOpenConditionalBuyOrders('acct', s.fetchPage)), 'CONTRACT');
  });

  it('a duplicate id, a broken offset or another account fails closed', async () => {
    const duplicate = server([row('a'), row('a')]);
    assert.equal(await failure(getOpenConditionalBuyOrders('acct', duplicate.fetchPage)), 'CONTRACT');
    const foreign = server([row('a')], { account: 'other' });
    assert.equal(await failure(getOpenConditionalBuyOrders('acct', foreign.fetchPage)), 'CONTRACT');
    const broken = (async () => ({ ...page('acct', [row('a')], 0, 3), pagination: { limit: 100, offset: 0, total: 3, returned: 1, nextOffset: 5 } })) as never;
    assert.equal(await failure(getOpenConditionalBuyOrders('acct', broken)), 'CONTRACT');
    const short = (async () => ({ ...page('acct', [row('a')], 0, 2), pagination: { limit: 100, offset: 0, total: 2, returned: 1, nextOffset: null } })) as never;
    assert.equal(await failure(getOpenConditionalBuyOrders('acct', short)), 'CONTRACT');
  });

  it('a row that ended between the filter and its presentation is not open', async () => {
    const s = server([row('a'), row('filled-now', 'filled'), row('c', 'triggered')]);
    const result = await getOpenConditionalBuyOrders('acct', s.fetchPage);
    assert.deepEqual(result.conditionalOrders.map((r) => r.id), ['a', 'c']);
  });

  it('a transport error stays an error, never an empty list', async () => {
    const fetchPage = (async () => { throw new Error('socket hang up'); }) as never;
    assert.equal(await failure(getOpenConditionalBuyOrders('acct', fetchPage)), 'OTHER');
  });
});

describe('ended Conditional BUY history', () => {
  it('rejects a page that is not the ended filter or names another account', () => {
    const ok = page('acct', [row('f', 'filled'), row('c', 'canceled'), row('x', 'order_rejected')], 0, 3);
    assert.equal(assertEndedConditionalBuyPage('acct', ok as never) === (ok as never), true);
    for (const bad of [
      page('acct', [row('f', 'filled'), row('w', 'watching')], 0, 2),
      page('acct', [row('p', 'order_pending')], 0, 1),
      page('other', [row('f', 'filled')], 0, 1),
    ])
      assert.throws(() => assertEndedConditionalBuyPage('acct', bad as never), ConditionalBuyListContractError);
  });

  it('merges pages keeping one copy, and drops from the open list a row the history already ended', () => {
    const merged = mergeConditionalBuyLists(
      [row('w1'), row('p1', 'order_pending')] as never,
      [page('acct', [row('f1', 'filled'), row('f2', 'canceled')], 0, 4), page('acct', [row('f2', 'canceled'), row('p1', 'filled')], 2, 4)] as never,
    );
    assert.deepEqual(merged.open.map((r) => r.id), ['w1']);
    assert.deepEqual(merged.ended.map((r) => r.id), ['f1', 'f2', 'p1']);
  });

  it('classifies open states exactly', () => {
    assert.deepEqual(
      ['watching', 'triggered', 'order_pending', 'filled', 'canceled', 'failed', 'order_canceled', 'order_rejected', 'unknown']
        .filter((state) => isOpenConditionalBuy({ state } as never)),
      ['watching', 'triggered', 'order_pending'],
    );
  });
});
