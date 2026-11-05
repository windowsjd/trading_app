import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PENDING_EVENT_SEEN_MAX,
  advancePendingEvents,
  buildPendingEventNotice,
  enqueuePendingEventNotices,
  parsePendingEventCursor,
  type PendingOrderEventDto,
} from './pendingEvents.ts';
import { enqueueFillNotice } from './fillTracker.ts';

const samsung = { id: 'samsung', symbol: '005930', name: '삼성전자', market: 'KRX' };
const btc = { id: 'btc', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE' };
const event = (overrides: Partial<PendingOrderEventDto>): PendingOrderEventDto => ({
  key: 'fill:spot_order:o1',
  type: 'fill',
  market: 'spot',
  origin: 'limit',
  side: 'buy',
  direction: null,
  asset: samsung,
  quantity: '3.00000000',
  price: '70000.00000000',
  currencyCode: 'KRW',
  executionType: null,
  at: '2026-11-05T01:00:00.000Z',
  visibleAt: '2026-11-05T01:00:00.000Z',
  ...overrides,
});
const page = (events: PendingOrderEventDto[], total = events.length) => ({
  tradingAccountId: 'general', serverTime: '2026-11-05T01:05:00.000Z', events, total,
});
const said = (notice: { title: string; detail: string | null } | null) => `${notice?.title} ${notice?.detail ?? ''}`;

describe('발동·체결 알림 cursor', () => {
  it('a stored cursor is read back; anything malformed is no cursor (nothing replayed)', () => {
    assert.deepEqual(parsePendingEventCursor(JSON.stringify({ cursor: '2026-11-05T01:00:00.000Z', seen: ['a', 3, 'b'] })),
      { cursor: '2026-11-05T01:00:00.000Z', seen: ['a', 'b'] });
    for (const raw of [null, '', 'not json', '{}', JSON.stringify({ cursor: 'yesterday' }), JSON.stringify({ cursor: '2026-13-45T99:00:00.000Z' }), 'null'])
      assert.equal(parsePendingEventCursor(raw), null, String(raw));
    const many = Array.from({ length: PENDING_EVENT_SEEN_MAX + 20 }, (_, i) => `k${i}`);
    assert.equal(parsePendingEventCursor(JSON.stringify({ cursor: '2026-11-05T01:00:00.000Z', seen: many }))?.seen.length, PENDING_EVENT_SEEN_MAX);
  });

  it('without a cursor a read only sets one: a first sign-in never replays history', () => {
    const result = advancePendingEvents(null, page([event({})]));
    assert.deepEqual(result, { announce: [], skipped: 0, next: { cursor: '2026-11-05T01:05:00.000Z', seen: [] } });
  });

  it('announces each key once across the look-back and inside one page, and counts what the page left out', () => {
    const previous = { cursor: '2026-11-05T01:00:00.000Z', seen: ['fill:spot_order:o1'] };
    const result = advancePendingEvents(previous, page([
      event({}), event({ key: 'trigger:conditional_buy:c1', type: 'trigger' }), event({ key: 'trigger:conditional_buy:c1', type: 'trigger' }),
    ], 60));
    assert.deepEqual(result.announce.map((row) => row.key), ['trigger:conditional_buy:c1']);
    assert.equal(result.skipped, 57);
    assert.deepEqual(result.next, { cursor: '2026-11-05T01:05:00.000Z', seen: ['fill:spot_order:o1', 'trigger:conditional_buy:c1'] });
    const full = { cursor: previous.cursor, seen: Array.from({ length: PENDING_EVENT_SEEN_MAX }, (_, i) => `k${i}`) };
    const bounded = advancePendingEvents(full, page([event({ key: 'new' })])).next.seen;
    assert.equal(bounded.length, PENDING_EVENT_SEEN_MAX);
    assert.equal(bounded.at(-1), 'new');
  });
});

describe('발동·체결 알림 copy', () => {
  it('a Spot fill reads like the in-session tracker and is keyed by its order', () => {
    const notice = buildPendingEventNotice('general', event({}), '일반모드');
    assert.deepEqual(notice, { id: 'general:o1', accountId: 'general', orderId: 'o1', title: '삼성전자 매수 체결 완료', detail: '일반모드 · 체결 수량 3' });
    assert.equal(buildPendingEventNotice('general', event({ origin: 'loc' }))?.title, '삼성전자 LOC 매수 체결 완료');
    assert.equal(said(buildPendingEventNotice('general', event({ origin: 'condition' }))), '삼성전자 매수 체결 완료 조건주문 · 체결 수량 3');
    assert.equal(said(buildPendingEventNotice('general', event({ origin: 'stop_loss', side: 'sell' }))), '삼성전자 매도 체결 완료 손절 · 체결 수량 3');
    assert.equal(said(buildPendingEventNotice('general', event({ origin: 'protection', side: 'sell' }))), '삼성전자 매도 체결 완료 기존 손절/익절 · 체결 수량 3');
  });

  it('a met condition says 조건 충족 and never 체결; its history is the one the order went to', () => {
    const cases: Array<[Partial<PendingOrderEventDto>, string]> = [
      [{ key: 'trigger:conditional_buy:c1', origin: 'condition', side: 'buy' }, '삼성전자 조건주문 매수 조건 충족'],
      [{ key: 'trigger:conditional_sell:c2', origin: 'condition', side: 'sell' }, '삼성전자 조건주문 매도 조건 충족'],
      [{ key: 'trigger:conditional_sell:c3', origin: 'stop_loss', side: 'sell' }, '삼성전자 손절 조건 충족'],
      [{ key: 'trigger:conditional_sell:c4', origin: 'take_profit', side: 'sell' }, '삼성전자 익절 조건 충족'],
      [{ key: 'trigger:futures_conditional_entry:f1', market: 'futures', origin: 'futures_condition', side: null, direction: 'long', asset: btc }, 'Bitcoin 롱 조건주문 조건 충족'],
      [{ key: 'trigger:futures_tp_sl:f2', market: 'futures', origin: 'futures_stop_loss', side: null, direction: 'short', asset: btc }, 'Bitcoin 숏 손절 조건 충족'],
    ];
    for (const [overrides, title] of cases) {
      const notice = buildPendingEventNotice('general', event({ type: 'trigger', quantity: null, executionType: 'market', ...overrides }));
      assert.equal(notice?.title, title);
      assert.equal(notice?.trigger, true);
      assert.doesNotMatch(said(notice), /체결/, title);
      assert.equal(notice?.detail, '감시가격 70000 도달 · 처리 결과는 거래 내역에서 확인할 수 있어요');
      assert.equal(notice?.orderId, overrides.key, 'a trigger never claims its order id');
      assert.deepEqual(notice?.history, overrides.market === 'futures' ? { market: 'futures', futuresView: 'executions' } : undefined);
    }
  });

  it('a Futures fill names its side and entry or close, and opens the Futures executions', () => {
    const entry = buildPendingEventNotice('season', event({ key: 'fill:futures_execution:e1', market: 'futures', origin: 'futures_limit', side: null,
      direction: 'long', asset: btc, quantity: '0.00500000', currencyCode: 'USD' }), '시즌 계정');
    assert.deepEqual(entry, { id: 'season:fill:futures_execution:e1', accountId: 'season', orderId: 'fill:futures_execution:e1',
      history: { market: 'futures', futuresView: 'executions' }, title: 'Bitcoin 롱 진입 체결 완료', detail: '시즌 계정 · 선물 지정가 · 체결 수량 0.005' });
    const close = buildPendingEventNotice('season', event({ key: 'fill:futures_execution:e2', market: 'futures', origin: 'futures_take_profit', side: null,
      direction: 'short', asset: btc, quantity: '1.00000000' }));
    assert.equal(said(close), 'Bitcoin 숏 익절 체결 완료 체결 수량 1');
  });

  it('a shape this app does not know is not announced', () => {
    assert.equal(buildPendingEventNotice('general', event({ type: 'canceled' as never })), null);
    assert.equal(buildPendingEventNotice('general', event({ side: null })), null);
    assert.equal(buildPendingEventNotice('general', event({ market: 'futures', direction: null })), null);
    assert.equal(buildPendingEventNotice('general', event({ key: '' })), null);
  });
});

describe('발동·체결 알림 queue', () => {
  const notice = (key: string, trigger = false) => buildPendingEventNotice('general', event(trigger
    ? { key: `trigger:conditional_buy:${key}`, type: 'trigger', origin: 'condition' } : { key: `fill:spot_order:${key}` }))!;

  it('one at a time: the rest fold into the last, and a folded condition makes the count neutral', () => {
    const fills = enqueuePendingEventNotices([], ['a', 'b', 'c', 'd'].map((key) => notice(key)), 0);
    assert.deepEqual(fills.map((row) => [row.orderId, row.overflow ?? 0, row.overflowMixed ?? false]), [['a', 0, false], ['b', 0, false], ['c', 1, false]]);
    const mixed = enqueuePendingEventNotices([], [notice('a'), notice('b'), notice('c'), notice('t', true)], 0);
    assert.equal(mixed.at(-1)?.overflowMixed, true);
    // What the server left out is of unknown kind.
    const skipped = enqueuePendingEventNotices([], [notice('a')], 12);
    assert.deepEqual([skipped[0].overflow, skipped[0].overflowMixed], [12, true]);
    assert.deepEqual(enqueuePendingEventNotices([], [], 12), [], 'nothing new: nothing folded either');
    assert.equal(enqueueFillNotice(fills, notice('a')).length, 3, 'a queued key is not queued twice');
  });
});
