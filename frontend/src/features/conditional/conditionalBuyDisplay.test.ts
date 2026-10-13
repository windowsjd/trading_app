import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getConditionalBuyCancelPath,
  getConditionalBuyDraftError,
  getConditionalBuyEndReason,
  getConditionalBuyResultNotice,
  getConditionalBuyStateLabel,
  isConditionAlreadyMet,
  isLiveConditionalBuy,
  type ConditionalBuyDraft,
} from './conditionalBuyDisplay.ts';

const order = (status: string) => ({
  orderId: 'o1', orderType: 'limit', status, quantity: '1', executedQuantity: null, limitPrice: '100', executedPrice: null,
  grossAmount: null, feeAmount: null, netAmount: null, reservedAmount: '100.1', cancelReason: null,
  submittedAt: null, executedAt: null, canceledAt: null,
});

describe('Conditional BUY state', () => {
  it('a met condition is never presented as a fill', () => {
    assert.equal(getConditionalBuyStateLabel('watching'), '감시 중');
    assert.equal(getConditionalBuyStateLabel('triggered'), '조건 충족 · 주문 처리 중');
    assert.equal(getConditionalBuyStateLabel('order_pending'), '주문 접수 · 체결 대기');
    assert.equal(getConditionalBuyStateLabel('filled'), '체결 완료');
    assert.equal(getConditionalBuyStateLabel('order_canceled'), '연결 주문 취소');
    assert.equal(getConditionalBuyStateLabel('order_rejected'), '연결 주문 거부');
    assert.equal(getConditionalBuyStateLabel('canceled'), '감시 취소');
    assert.equal(getConditionalBuyStateLabel('failed'), '실행 실패');
    assert.equal(getConditionalBuyStateLabel('something_new'), '상태 확인 필요');
    assert.equal(isLiveConditionalBuy({ state: 'triggered' }), true);
    assert.equal(isLiveConditionalBuy({ state: 'order_pending' }), false);
  });

  it('cancels the watch before ordering, the linked limit order after, nothing once terminal', () => {
    assert.deepEqual(getConditionalBuyCancelPath({ state: 'watching', order: null }), { kind: 'conditional' });
    assert.deepEqual(getConditionalBuyCancelPath({ state: 'triggered', order: null }), { kind: 'conditional' });
    assert.deepEqual(getConditionalBuyCancelPath({ state: 'order_pending', order: order('submitted') }), { kind: 'order', orderId: 'o1' });
    for (const state of ['filled', 'canceled', 'failed', 'order_canceled', 'order_rejected'] as const)
      assert.equal(getConditionalBuyCancelPath({ state, order: order('executed') }) === null, true, state);
    // A stale pending state with an already-terminal order offers no cancel.
    assert.equal(getConditionalBuyCancelPath({ state: 'order_pending', order: order('executed') }) === null, true);
  });

  it('explains how a row ended without exposing server codes', () => {
    const base = { order: null, terminalReason: null, failureCode: null };
    assert.equal(getConditionalBuyEndReason({ ...base, state: 'failed', failureCode: 'INSUFFICIENT_AVAILABLE_BALANCE' }), '발동 시점의 사용 가능 현금이 부족했어요.');
    assert.equal(getConditionalBuyEndReason({ ...base, state: 'failed', terminalReason: 'execution_window_expired' }), '조건 충족 후 30초 안에 주문을 만들지 못했어요.');
    assert.equal(getConditionalBuyEndReason({ ...base, state: 'failed', failureCode: 'SOMETHING' }), '조건 충족 후 주문을 만들지 못했어요.');
    assert.equal(getConditionalBuyEndReason({ ...base, state: 'canceled', terminalReason: 'season_ended' }), '시즌 종료로 감시가 끝났어요.');
    assert.equal(getConditionalBuyEndReason({ ...base, state: 'order_canceled', order: { ...order('canceled'), cancelReason: 'user_canceled' } }), '연결된 지정가 주문을 취소했어요.');
    assert.equal(getConditionalBuyEndReason({ ...base, state: 'watching' }), null);
  });
});

describe('Conditional BUY draft', () => {
  const draft = (overrides: Partial<ConditionalBuyDraft> = {}): ConditionalBuyDraft => ({
    assetType: 'domestic_stock', triggerCondition: 'at_or_below', triggerPrice: '69000', executionType: 'market', limitPrice: '', size: '2', ...overrides,
  });

  it('needs a chosen condition and a watch price; the limit price is a separate field', () => {
    assert.equal(getConditionalBuyDraftError(draft()), null);
    assert.match(getConditionalBuyDraftError(draft({ triggerCondition: null })) ?? '', /감시 조건/);
    assert.match(getConditionalBuyDraftError(draft({ triggerPrice: '' })) ?? '', /감시가격/);
    assert.match(getConditionalBuyDraftError(draft({ triggerPrice: '0' })) ?? '', /감시가격/);
    assert.match(getConditionalBuyDraftError(draft({ executionType: 'limit' })) ?? '', /지정가격을 입력/);
    assert.equal(getConditionalBuyDraftError(draft({ executionType: 'limit', limitPrice: '68500' })), null);
  });

  it('stocks use quantity (integer for limit); crypto uses a fee-exclusive amount', () => {
    assert.equal(getConditionalBuyDraftError(draft({ size: '0.5' })), null, 'market may use a fractional stock quantity');
    assert.match(getConditionalBuyDraftError(draft({ executionType: 'limit', limitPrice: '68500', size: '0.5' })) ?? '', /정수 수량/);
    assert.match(getConditionalBuyDraftError(draft({ size: '0.1234567' })) ?? '', /6자리/);
    assert.equal(getConditionalBuyDraftError(draft({ assetType: 'crypto', triggerPrice: '0.12345678', size: '25.12345678' })), null);
    assert.match(getConditionalBuyDraftError(draft({ assetType: 'crypto', size: '' })) ?? '', /매수 금액/);
  });

  it('hints when the screen price already meets the condition (the server still decides)', () => {
    assert.equal(isConditionAlreadyMet('at_or_below', '69000', '68000'), true);
    assert.equal(isConditionAlreadyMet('at_or_below', '69000', '70000'), false);
    assert.equal(isConditionAlreadyMet('at_or_above', '71000', '71000'), true, 'equality triggers');
    assert.equal(isConditionAlreadyMet('at_or_above', '71000', null), false);
    assert.equal(isConditionAlreadyMet(null, '71000', '72000'), false);
  });
});

describe('Conditional BUY create result (first answer or same-key replay)', () => {
  const result = (state: string, extra: Record<string, unknown> = {}) =>
    getConditionalBuyResultNotice({ state, failureCode: null, terminalReason: null, order: null, ...extra } as never);

  it('follows the server state: registered, condition met, order accepted and filled never blur', () => {
    assert.equal(result('watching').title, '조건주문이 등록되었습니다. 감시 중입니다.');
    assert.equal(result('triggered').title, '조건이 충족되어 주문을 처리하고 있어요.');
    assert.equal(result('triggered').detail, '아직 체결된 것은 아니에요.');
    assert.equal(result('order_pending', { order: order('submitted') }).title, '조건이 충족되어 지정가 매수가 접수됐어요. 체결을 기다리고 있어요.');
    assert.equal(result('filled', { order: order('executed') }).title, '조건주문의 매수가 체결됐어요.');
    const titles = ['watching', 'triggered', 'order_pending', 'filled'].map((state) => result(state).title);
    assert.equal(new Set(titles).size, 4);
    for (const state of ['watching', 'triggered', 'order_pending'])
      assert.equal(/체결됐|체결 완료/u.test(result(state).title), false, `${state} is not a fill`);
  });

  it('ended rows are never shown as watching and say why', () => {
    for (const state of ['failed', 'canceled', 'order_canceled', 'order_rejected', 'filled']) {
      assert.equal(result(state).title.includes('감시 중'), false, state);
      assert.equal(result(state).next.includes('종료 이력'), true, state);
    }
    assert.equal(result('failed', { failureCode: 'INSUFFICIENT_BALANCE' }).detail, '발동 시점의 잔액이 부족했어요.');
    assert.equal(result('failed').tone, 'error');
    assert.equal(result('canceled', { terminalReason: 'season_ended' }).detail, '시즌 종료로 감시가 끝났어요.');
    assert.equal(result('order_canceled', { order: { ...order('canceled'), cancelReason: 'user_canceled' } }).detail, '연결된 지정가 주문을 취소했어요.');
    assert.equal(result('order_rejected').title, '연결된 주문이 거부됐어요.');
    assert.equal(result('mystery').title, '조건주문 상태를 확인하지 못했어요.');
    for (const state of ['watching', 'triggered', 'order_pending']) assert.equal(result(state).next.includes('취소'), true, state);
  });
});
