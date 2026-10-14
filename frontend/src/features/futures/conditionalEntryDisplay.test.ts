import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getFuturesConditionalCancelPath,
  getFuturesConditionalEndReason,
  getFuturesConditionalStateLabel,
} from './conditionalEntryDisplay.ts';
import type { FuturesConditionalEntry } from './api';

type Row = Pick<FuturesConditionalEntry, 'state' | 'executionType' | 'terminalReason' | 'failureCode' | 'limitOrder'>;
const row = (patch: Partial<Row>): Row => ({
  state: 'watching', executionType: 'market', terminalReason: null, failureCode: null, limitOrder: null, ...patch,
});
const limitOrder = (status: 'submitted' | 'executed' | 'canceled') => ({
  orderId: 'limit-1', status, limitPrice: '111', reservedAmount: '5.6', executionId: null,
  terminalReason: null, createdAt: '2026-10-14T00:00:00.000Z', endedAt: null,
});

describe('futures conditional entry display', () => {
  it('never reads a met condition as filled', () => {
    assert.equal(getFuturesConditionalStateLabel(row({ state: 'watching' })), '감시 중');
    assert.equal(getFuturesConditionalStateLabel(row({ state: 'triggered' })), '발동 · 주문 생성 중');
    assert.equal(getFuturesConditionalStateLabel(row({ state: 'order_pending', executionType: 'limit' })), '발동 · 지정가 주문 대기');
    assert.equal(getFuturesConditionalStateLabel(row({ state: 'filled' })), '발동 · 시장가 체결');
    assert.equal(getFuturesConditionalStateLabel(row({ state: 'filled', executionType: 'limit' })), '발동 · 지정가 체결');
    assert.equal(getFuturesConditionalStateLabel(row({ state: 'order_canceled', executionType: 'limit' })), '발동 · 지정가 주문 취소');
    assert.equal(getFuturesConditionalStateLabel(row({ state: 'failed' })), '발동 후 주문 실패');
  });

  it('separates a user cancel from a Season/account policy end', () => {
    assert.equal(getFuturesConditionalStateLabel(row({ state: 'canceled', terminalReason: 'user_canceled' })), '사용자 취소');
    for (const reason of ['season_ended', 'participant_excluded', 'account_not_tradable', 'instrument_not_tradable']) {
      assert.equal(getFuturesConditionalStateLabel(row({ state: 'canceled', terminalReason: reason })), '정책에 따라 종료');
      assert.notEqual(getFuturesConditionalEndReason(row({ state: 'canceled', terminalReason: reason })), '직접 취소했습니다.');
    }
    assert.match(getFuturesConditionalEndReason(row({ state: 'canceled', terminalReason: 'season_ended' })) ?? '', /시즌이 종료/);
  });

  it('explains failures by the engine code or the expired window', () => {
    assert.match(getFuturesConditionalEndReason(row({ state: 'failed', failureCode: 'INSUFFICIENT_FUTURES_FREE_COLLATERAL', terminalReason: 'execution_failed' })) ?? '', /담보가 부족/);
    assert.match(getFuturesConditionalEndReason(row({ state: 'failed', failureCode: 'FUTURES_POSITION_ALREADY_OPEN', terminalReason: 'execution_failed' })) ?? '', /보유 포지션/);
    assert.match(getFuturesConditionalEndReason(row({ state: 'failed', failureCode: 'FUTURES_MARK_STALE', terminalReason: 'execution_window_expired' })) ?? '', /30초/);
    assert.equal(getFuturesConditionalEndReason(row({ state: 'failed', failureCode: 'SOMETHING_NEW', terminalReason: 'execution_failed' })), '주문을 실행하지 못했습니다.');
    assert.equal(getFuturesConditionalEndReason(row({ state: 'watching' })), null);
  });

  it('cancels the watch, its created limit entry, or nothing', () => {
    assert.deepEqual(getFuturesConditionalCancelPath(row({ state: 'watching' })), { kind: 'entry' });
    assert.deepEqual(getFuturesConditionalCancelPath(row({ state: 'triggered' })), { kind: 'entry' });
    assert.deepEqual(getFuturesConditionalCancelPath(row({ state: 'order_pending', limitOrder: limitOrder('submitted') })), { kind: 'limit', orderId: 'limit-1' });
    for (const state of ['filled', 'order_canceled', 'failed', 'canceled'] as const)
      assert.equal(getFuturesConditionalCancelPath(row({ state, limitOrder: limitOrder('executed') })), null);
  });
});
