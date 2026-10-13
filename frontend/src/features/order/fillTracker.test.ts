import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FILL_RETRY_BASE_MS,
  FILL_RETRY_MAX_MS,
  FILL_SETTLED_MAX,
  FILL_UNRESOLVED_MAX,
  FILL_UNRESOLVED_MAX_AGE_MS,
  buildFillNotice,
  createFillTracker,
  enqueueFillNotice,
  fillRetryDelay,
  isFillWatchAccount,
  isTransientFillReadFailure,
  type FillNotice,
} from './fillTracker.ts';

const executed = (overrides: Record<string, unknown> = {}) => ({
  orderId: 'o1',
  status: 'executed',
  side: 'buy',
  executedAt: '2026-10-13T06:40:00.000Z',
  quantity: '3.000000',
  asset: { name: '삼성전자', symbol: '005930' },
  ...overrides,
});

describe('fill tracker set diff', () => {
  it('the first complete read is a baseline: past fills and open orders are not announced', () => {
    const tracker = createFillTracker();
    assert.deepEqual(tracker.observePending('a', ['o1', 'o2']), []);
    assert.equal(tracker.hasOpenOrders('a'), true);
  });

  it('an order that leaves the open set is a candidate, however old its submission', () => {
    const tracker = createFillTracker();
    // 150 open orders: an old one far beyond any first page still diffs.
    const ids = Array.from({ length: 150 }, (_, i) => `o${i}`);
    tracker.observePending('a', ids);
    assert.deepEqual(tracker.observePending('a', ids.filter((id) => id !== 'o149')), ['o149']);
    assert.deepEqual(tracker.observePending('a', ids.filter((id) => id !== 'o149')), []);
  });

  it('an order created here is tracked before any read sees it', () => {
    const tracker = createFillTracker();
    tracker.trackOrder('a', 'new');
    assert.deepEqual(tracker.observePending('a', []), ['new']);
    assert.equal(tracker.hasOpenOrders('a'), false);
  });

  it('accounts never share open sets', () => {
    const tracker = createFillTracker();
    tracker.observePending('a', ['o1']);
    tracker.observePending('b', ['o2']);
    assert.deepEqual(tracker.observePending('b', []), ['o2']);
    assert.deepEqual(tracker.observePending('a', ['o1']), []);
    assert.equal(tracker.hasOpenOrders('b'), false);
    assert.equal(tracker.hasOpenOrders('a'), true);
  });

  it('watches diff the same way and are separate from orders', () => {
    const tracker = createFillTracker();
    tracker.observeWatches('a', ['w1']);
    tracker.trackWatch('a', 'w2');
    assert.deepEqual(tracker.observeWatches('a', ['w1']), ['w2']);
    assert.equal(tracker.hasOpenWatches('a'), true);
    assert.equal(tracker.hasOpenOrders('a'), false);
  });

  it('settles one announcement per account and order across every path', () => {
    const tracker = createFillTracker();
    assert.equal(tracker.settle('a', 'o1'), true);
    assert.equal(tracker.settle('a', 'o1'), false, 'refetch / replay / second path');
    assert.equal(tracker.settle('b', 'o1'), true, 'another account is another key');
  });

  it('remembers a conditional origin for a linked limit order', () => {
    const tracker = createFillTracker();
    tracker.trackOrder('a', 'o9', 'conditional');
    tracker.trackOrder('a', 'o9');
    assert.equal(tracker.originOf('a', 'o9'), 'conditional');
    assert.equal(tracker.originOf('a', 'other'), 'order');
  });

});

describe('unresolved detail reads', () => {
  const order = (id: string) => ({ kind: 'order' as const, id, origin: 'order' as const });

  it('a failed read is kept past any attempt count, re-read with a bounded backoff', () => {
    const tracker = createFillTracker();
    let now = 1_000_000;
    const delays: number[] = [];
    for (let failure = 1; failure <= 8; failure++) {
      tracker.defer('a', order('o1'), now);
      const next = tracker.nextRetryAt('a');
      assert.equal(next !== null, true, `still tracked after ${failure} failures`);
      delays.push(next! - now);
      assert.deepEqual(tracker.due('a', next! - 1), [], 'not before its backoff');
      now = next!;
      assert.deepEqual(tracker.due('a', now), [order('o1')]);
    }
    assert.deepEqual(delays, [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    assert.equal(fillRetryDelay(1), FILL_RETRY_BASE_MS);
    assert.equal(fillRetryDelay(50), FILL_RETRY_MAX_MS);
  });

  it('an answered read stops retries; one read per target at a time', () => {
    const tracker = createFillTracker();
    tracker.defer('a', order('o1'), 0);
    assert.equal(tracker.beginRead('a', 'order', 'o1'), true);
    assert.equal(tracker.beginRead('a', 'order', 'o1'), false, 'a concurrent read of the same order is skipped');
    assert.equal(tracker.beginRead('a', 'watch', 'o1'), true, 'a watch with the same id is another target');
    assert.deepEqual(tracker.due('a', FILL_RETRY_MAX_MS), [], 'a target being read is not due again');
    assert.equal(tracker.nextRetryAt('a'), null);
    tracker.endRead('a', 'order', 'o1');
    assert.equal(tracker.nextRetryAt('a'), FILL_RETRY_BASE_MS);
    tracker.resolved('a', 'order', 'o1');
    assert.equal(tracker.nextRetryAt('a'), null);
    assert.deepEqual(tracker.due('a', FILL_RETRY_MAX_MS), []);
  });

  it('coming back to the foreground makes every unresolved target due once, per account', () => {
    const tracker = createFillTracker();
    tracker.defer('a', order('o1'), 0);
    tracker.defer('b', { kind: 'watch', id: 'w1', origin: 'conditional' }, 0);
    assert.deepEqual(tracker.due('a', 1), []);
    tracker.wake(1);
    assert.deepEqual(tracker.due('a', 1), [order('o1')]);
    assert.deepEqual(tracker.due('b', 1), [{ kind: 'watch', id: 'w1', origin: 'conditional' }]);
  });

  it('keeps memory and requests bounded: a per-account cap and a maximum age', () => {
    const tracker = createFillTracker();
    for (let i = 0; i <= FILL_UNRESOLVED_MAX; i++) tracker.defer('a', order(`o${i}`), i);
    const due = tracker.due('a', FILL_RETRY_MAX_MS * 2).map((target) => target.id);
    assert.equal(due.length, FILL_UNRESOLVED_MAX);
    assert.equal(due.includes('o0'), false, 'the oldest gives way');
    assert.equal(tracker.due('b', FILL_RETRY_MAX_MS * 2).length, 0, 'accounts never share targets');
    tracker.defer('c', order('old'), 0);
    tracker.defer('c', order('old'), FILL_UNRESOLVED_MAX_AGE_MS);
    assert.equal(tracker.nextRetryAt('c'), null, 'given up a day after the first failure');
    tracker.defer('d', order('stale'), 0);
    assert.deepEqual(tracker.due('d', FILL_UNRESOLVED_MAX_AGE_MS), []);
    assert.equal(tracker.nextRetryAt('d'), null);
  });

  it('only a definite refusal stops asking; transport and server errors are transient', () => {
    assert.equal(isTransientFillReadFailure({ hasResponse: false, status: null }), true);
    for (const status of [500, 502, 503, 408, 429, 401]) assert.equal(isTransientFillReadFailure({ hasResponse: true, status }), true, String(status));
    for (const status of [400, 403, 404, 410, 422]) assert.equal(isTransientFillReadFailure({ hasResponse: true, status }), false, String(status));
  });

  it('a settled order leaves the unresolved targets', () => {
    const tracker = createFillTracker();
    tracker.defer('a', order('o1'), 0);
    assert.equal(tracker.settle('a', 'o1'), true);
    assert.equal(tracker.nextRetryAt('a'), null);
  });
});

describe('fill notice is built from a server execution only', () => {
  it('announces an executed order', () => {
    const notice = buildFillNotice('a', executed());
    assert.equal(notice?.title, '삼성전자 매수 체결 완료');
    assert.equal(notice?.detail, '체결 수량 3');
    assert.equal(notice?.id, 'a:o1');
    assert.equal(notice?.accountId, 'a');
  });

  it('never announces submitted, canceled, rejected or unconfirmed orders', () => {
    for (const status of ['submitted', 'canceled', 'rejected', undefined])
      assert.equal(buildFillNotice('a', executed({ status })) === null, true, String(status));
    assert.equal(buildFillNotice('a', executed({ executedAt: null })) === null, true);
    assert.equal(buildFillNotice('a', executed({ orderId: undefined })) === null, true);
    assert.equal(buildFillNotice('a', executed({ side: undefined })) === null, true);
  });

  it('says LOC, sell, partial and conditional plainly', () => {
    assert.equal(buildFillNotice('a', executed({ limitOnClose: { status: 'filled' } }))?.title, '삼성전자 LOC 매수 체결 완료');
    assert.equal(buildFillNotice('a', executed({ side: 'sell' }))?.title, '삼성전자 매도 체결 완료');
    const partial = buildFillNotice('a', executed({
      asset: { name: '비트코인', symbol: 'BTCUSDT' },
      marketExecution: { status: 'partial', executedQuantity: '0.004' },
    }));
    assert.equal(partial?.title, '비트코인 매수 일부 체결');
    assert.equal(partial?.detail, '체결 수량 0.004');
    assert.equal(buildFillNotice('a', executed(), { origin: 'conditional', accountLabel: '일반모드' })?.detail, '일반모드 · 조건주문 · 체결 수량 3');
  });
});

describe('banner queue', () => {
  const notice = (id: string): FillNotice => ({ id, accountId: 'a', orderId: id, title: id, detail: null });

  it('drops a repeated notice and keeps at most three, folding the rest into the last', () => {
    let queue: FillNotice[] = [];
    for (const id of ['1', '1', '2', '3', '4', '5']) queue = enqueueFillNotice(queue, notice(id));
    assert.deepEqual(queue.map((item) => item.id), ['1', '2', '3']);
    assert.equal(queue[2].overflow, 2);
    assert.equal(queue[0].overflow, undefined);
  });
});

describe('watched accounts', () => {
  it('watches open general/beginner accounts and only active Season accounts', () => {
    assert.equal(isFillWatchAccount({ status: 'active', mode: 'general' }), true);
    assert.equal(isFillWatchAccount({ status: 'suspended', mode: 'beginner' }), true);
    assert.equal(isFillWatchAccount({ status: 'closed', mode: 'general' }), false);
    assert.equal(isFillWatchAccount({ status: 'active', mode: 'season', season: { seasonStatus: 'active' } }), true);
    assert.equal(isFillWatchAccount({ status: 'active', mode: 'season', season: { seasonStatus: 'ended' } }), false);
    assert.equal(isFillWatchAccount({ status: 'active', mode: 'season', season: null }), false);
  });
});

describe('SELL intents and bounded session memory', () => {
  it('SELL intents diff in their own set, apart from BUY watches and orders', () => {
    const tracker = createFillTracker();
    tracker.observeWatches('a', ['w1']);
    tracker.observeSellWatches('a', ['s1', 's2']);
    tracker.trackSellWatch('a', 's3');
    assert.deepEqual(tracker.observeSellWatches('a', ['s2']), ['s1', 's3']);
    assert.deepEqual(tracker.observeWatches('a', ['w1']), []);
    assert.equal(tracker.hasOpenSellWatches('a'), true);
    assert.equal(tracker.hasOpenOrders('a'), false);
    assert.deepEqual(tracker.observeSellWatches('a', []), ['s2']);
    assert.equal(tracker.hasOpenSellWatches('a'), false);
  });

  it('SELL intent reads are single-flight and retried with their own kind', () => {
    const tracker = createFillTracker();
    assert.equal(tracker.beginRead('a', 'sell_watch', 's1'), true);
    assert.equal(tracker.beginRead('a', 'sell_watch', 's1'), false);
    // Same id as a BUY watch or an order is a different target.
    assert.equal(tracker.beginRead('a', 'watch', 's1'), true);
    assert.equal(tracker.beginRead('a', 'order', 's1'), true);
    tracker.endRead('a', 'sell_watch', 's1');
    tracker.defer('a', { kind: 'sell_watch', id: 's1', origin: 'conditional' }, 0);
    assert.deepEqual(tracker.due('a', FILL_RETRY_BASE_MS), [{ kind: 'sell_watch', id: 's1', origin: 'conditional' }]);
  });

  it('an announced or cancel-resolved order leaves no origin or pending entry behind', () => {
    const tracker = createFillTracker();
    tracker.trackOrder('a', 'o1', 'stop_loss');
    tracker.trackOrder('a', 'o2', 'take_profit');
    assert.equal(tracker.originOf('a', 'o1'), 'stop_loss');
    assert.equal(tracker.settle('a', 'o1'), true);
    assert.equal(tracker.originOf('a', 'o1'), 'order', 'origin dropped once announced');
    tracker.forgetOrder('a', 'o2');
    assert.equal(tracker.originOf('a', 'o2'), 'order');
    assert.equal(tracker.hasOpenOrders('a'), false);
    // Deduplication still holds for the announced one.
    assert.equal(tracker.settle('a', 'o1'), false);
  });

  it('keeps deduplicating recent announcements while bounding the whole session', () => {
    const tracker = createFillTracker();
    for (let i = 0; i < FILL_SETTLED_MAX + 1; i++) assert.equal(tracker.settle('a', `o${i}`), true);
    // The most recent ones are still remembered (no duplicate banner).
    assert.equal(tracker.settle('a', `o${FILL_SETTLED_MAX}`), false);
    assert.equal(tracker.settle('a', `o${FILL_SETTLED_MAX - 1}`), false);
    // Only the oldest beyond the bound was forgotten.
    assert.equal(tracker.settle('a', 'o0'), true);
  });

  it('names SELL fills by their origin and LOC SELL by its type', () => {
    const stop = buildFillNotice('a', executed({ side: 'sell' }), { origin: 'stop_loss' });
    assert.equal(stop?.title, '삼성전자 매도 체결 완료');
    assert.equal(stop?.detail, '손절 · 체결 수량 3');
    assert.equal(buildFillNotice('a', executed({ side: 'sell' }), { origin: 'take_profit' })?.detail, '익절 · 체결 수량 3');
    assert.equal(buildFillNotice('a', executed({ side: 'sell' }), { origin: 'conditional' })?.detail, '조건주문 · 체결 수량 3');
    assert.equal(buildFillNotice('a', executed({ side: 'sell', limitOnClose: { status: 'filled' } }))?.title, '삼성전자 LOC 매도 체결 완료');
    // Never from a submitted or canceled order.
    assert.equal(buildFillNotice('a', executed({ side: 'sell', status: 'submitted' }), { origin: 'stop_loss' }), null);
    assert.equal(buildFillNotice('a', executed({ side: 'sell', status: 'canceled' })), null);
  });
});
