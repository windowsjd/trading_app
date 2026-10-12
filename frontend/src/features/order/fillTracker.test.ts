import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FILL_RESOLVE_MAX_ATTEMPTS,
  buildFillNotice,
  createFillTracker,
  enqueueFillNotice,
  isFillWatchAccount,
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

  it('bounds retries of a failing detail read', () => {
    const tracker = createFillTracker();
    const results = Array.from({ length: FILL_RESOLVE_MAX_ATTEMPTS }, () => tracker.retry('a', 'o1'));
    assert.deepEqual(results, [true, true, false]);
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
