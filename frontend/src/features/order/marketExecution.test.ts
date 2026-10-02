import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { CreateOrderDto, MarketExecutionDto } from './api.ts';
import { getOrderSuccessDisplay, isOrderSuccess } from './mapper.ts';
import { getOrderStatusLabel, isOpenLimitOrder } from '../record/openOrder.ts';
import { toRecordOrderItem } from '../record/accountOrders.ts';
const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');
const records = load(path.resolve('src/features/record/api.ts'), {
  '../../services/api/client': {},
});
export const partial: MarketExecutionDto = {
  status: 'partial',
  requestedQuantity: '1000',
  executedQuantity: '800',
  canceledQuantity: '200',
  requestedAmount: null,
  unspentAmount: null,
  remainderCancelReason: 'insufficient_market_liquidity',
  remainderCanceledAt: '2026-10-02T01:00:00Z',
};
const result: CreateOrderDto = {
  order: {
    orderType: 'market',
    status: 'executed',
    side: 'buy',
    quantity: '1000',
    executedPrice: '100.0875',
    currencyCode: 'KRW',
    grossAmount: '80070',
    feeAmount: '80.07',
    netAmount: '80150.07',
    marketExecution: partial,
  },
  execution: { state: 'executed', executePrice: '100.0875' },
};
describe('one-shot market result disclosure', () => {
  it('renders actual quantity/amount/VWAP while keeping requested/canceled quantities separate', () => {
    const display = getOrderSuccessDisplay(result, 4);
    assert.equal(display.quantity, '800');
    assert.equal(display.requestedQuantity, '1000');
    assert.equal(display.canceledQuantity, '200');
    assert.equal(display.isPartialExecution, true);
    assert.match(display.executedPrice, /100.0875/);
    assert.match(display.grossAmount, /80,070/);
    assert.match(display.feeAmount, /80.07/);
    assert.match(display.remainderMessage!, /시장 유동성 부족.*200.*자동 취소/);
    assert.equal(isOrderSuccess(result), true);
    assert.deepEqual(
      getOrderSuccessDisplay(JSON.parse(JSON.stringify(result)), 4),
      display,
    );
  });
  it('uses principal intent for amount BUY instead of a canceled quantity', () => {
    const display = getOrderSuccessDisplay({
      ...result,
      order: {
        ...result.order,
        marketExecution: {
          ...partial,
          requestedQuantity: null,
          canceledQuantity: null,
          requestedAmount: '100',
          unspentAmount: '39.98',
          executedQuantity: '0.6',
        },
        currencyCode: 'USD',
        grossAmount: '60.02',
      },
    });
    assert.equal(display.isAmountExecution, true);
    assert.match(display.requestedAmount, /100/);
    assert.match(display.unspentAmount, /39.98/);
    assert.equal(display.quantity, '0.6');
    assert.match(display.remainderMessage!, /사용되지 않은 주문 금액/);
  });
  it('maps account/history rows using the same authoritative result and never polls the remainder', () => {
    const item = toRecordOrderItem(result.order as Record<string, unknown>);
    assert.deepEqual(item.marketExecution, partial);
    const display = records.getRecordOrderDisplay(item);
    assert.equal(display.statusLabel, '부분체결 · 잔량 자동취소');
    assert.equal(display.quantity, '800');
    assert.equal(display.requestedQuantity, '1000');
    assert.equal(isOpenLimitOrder(item), false);
  });
  it('discloses positive sub-cent unused principal without rounding it to zero', () => {
    const display = getOrderSuccessDisplay({
      ...result,
      order: {
        ...result.order,
        currencyCode: 'USD',
        marketExecution: {
          ...partial,
          requestedAmount: '1',
          unspentAmount: '0.00000001',
          requestedQuantity: null,
          canceledQuantity: null,
        },
      },
    });
    assert.equal(display.unspentAmount, '$0.00000001');
  });
  it('preserves legacy full-fill and limit labels', () => {
    assert.equal(
      getOrderSuccessDisplay({
        ...result,
        order: { ...result.order, marketExecution: undefined },
      }).isPartialExecution,
      false,
    );
    assert.equal(getOrderStatusLabel('executed'), '체결');
    assert.equal(getOrderStatusLabel('submitted'), '미체결');
    assert.equal(getOrderStatusLabel('canceled'), '취소');
    const submitted = getOrderSuccessDisplay({
      ...result,
      execution: { state: 'submitted' },
      order: { orderType: 'limit', quantity: '1000' },
    });
    assert.equal(submitted.isSubmittedLimitOrder, true);
    assert.equal(submitted.grossAmount, '-');
  });
});
