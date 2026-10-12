import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OrderQuoteValidationError, validateOrderQuote } from './validateOrderQuote.ts';
import { getLimitOnCloseStatusLabel, getOrderTypeLabel } from '../record/openOrder.ts';
import { toRecordOrderItem } from '../record/accountOrders.ts';
import type { OrderQuoteDto, OrderQuoteRequestDto } from './api';

const preview = {
  market: 'KRX',
  sessionDate: '2026-10-13',
  sessionOpenAt: '2026-10-13T00:00:00.000Z',
  sessionCloseAt: '2026-10-13T06:30:00.000Z',
  evidenceDeadlineAt: '2026-10-13T09:30:00.000Z',
  executionPricePolicy: 'final_regular_session_close',
};
const request: OrderQuoteRequestDto = {
  assetId: 'samsung', side: 'buy', quantity: '2', orderType: 'limit', limitPrice: '70000', limitOnClose: true,
};
const quote = (overrides: Partial<OrderQuoteDto> = {}) => ({
  state: 'available', quoteId: 'q1', asset: { id: 'samsung' }, side: 'buy', orderType: 'limit', quantity: '2.000000',
  limitPrice: '70000.00000000', expiresAt: new Date(Date.now() + 15_000).toISOString(), limitOnClose: preview,
  ...overrides,
}) as OrderQuoteDto;

describe('LOC quote binding', () => {
  it('accepts a LOC quote carrying the server session preview', () => {
    assert.doesNotThrow(() => validateOrderQuote(request, quote()));
  });

  it('refuses a LOC request answered by an ordinary limit quote, and the reverse', () => {
    assert.throws(() => validateOrderQuote(request, quote({ limitOnClose: undefined })), OrderQuoteValidationError);
    const ordinary: OrderQuoteRequestDto = { ...request, limitOnClose: undefined };
    assert.throws(() => validateOrderQuote(ordinary, quote()), OrderQuoteValidationError);
    assert.doesNotThrow(() => validateOrderQuote(ordinary, quote({ limitOnClose: undefined })));
  });

  it('LOC stays an ordinary limit quote for every other check', () => {
    assert.throws(() => validateOrderQuote(request, quote({ orderType: 'market' })), OrderQuoteValidationError);
    assert.throws(() => validateOrderQuote(request, quote({ limitPrice: '69000' })), OrderQuoteValidationError);
  });
});

describe('LOC rows in lists', () => {
  it('names the order type with its side', () => {
    assert.equal(getOrderTypeLabel({ orderType: 'limit', side: 'buy', limitOnClose: { status: 'pending' } }), 'LOC 매수');
    assert.equal(getOrderTypeLabel({ orderType: 'limit', side: 'sell' }), '지정가 매도');
    assert.equal(getOrderTypeLabel({ orderType: 'market', side: 'buy' }), '매수');
  });

  it('acceptance is never a fill; unfilled and expired release their reservation', () => {
    assert.equal(getLimitOnCloseStatusLabel({ status: 'pending' }, 'submitted'), '종가 판정 대기');
    assert.equal(getLimitOnCloseStatusLabel({ status: 'filled' }, 'executed'), '체결 (확정 종가)');
    assert.equal(getLimitOnCloseStatusLabel({ status: 'unfilled' }, 'canceled'), '미체결 종료 · 예약 해제');
    assert.equal(getLimitOnCloseStatusLabel({ status: 'expired' }, 'canceled'), '판정 기한 만료 · 예약 해제');
    assert.equal(getLimitOnCloseStatusLabel({ status: 'canceled' }, 'canceled'), '취소');
  });

  it('keeps the server LOC state on account-scoped rows', () => {
    const row = toRecordOrderItem({ orderId: 'o1', side: 'buy', orderType: 'limit', status: 'submitted', quantity: '2', limitOnClose: { ...preview, status: 'pending' } });
    assert.equal(row.limitOnClose?.status, 'pending');
    assert.equal(toRecordOrderItem({ orderId: 'o2', side: 'buy', quantity: '1' }).limitOnClose, null);
  });
});
