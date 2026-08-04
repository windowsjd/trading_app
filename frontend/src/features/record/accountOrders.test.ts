import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toRecordOrderItem, toRecordOrderItems } from './accountOrders.ts';
// `openOrder.ts` is deliberately free of the api-client import chain, so the
// predicate the list's polling and cancel button depend on can be exercised
// here. `record/api.ts` itself pulls in axios + AsyncStorage and is not
// loadable under `node --test`.
import { isOpenLimitBuyOrder } from './openOrder.ts';

/** A row exactly as `/trading-accounts/:id/orders` serialises it. */
function accountOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order-1',
    quoteId: 'quote-1',
    asset: {
      id: 'asset-1',
      symbol: '005930',
      name: '삼성전자',
      market: 'KRX',
      currencyCode: 'KRW',
    },
    side: 'buy',
    orderType: 'limit',
    status: 'submitted',
    quantity: '10.000000',
    limitPrice: '70000.00',
    executedPrice: null,
    currencyCode: 'KRW',
    grossAmount: null,
    feeAmount: null,
    netAmount: null,
    reservedAmount: '701400.00',
    reservationReleasedAt: null,
    cancelReason: null,
    submittedAt: '2026-08-04T01:00:00.000Z',
    executedAt: null,
    ...overrides,
  };
}

describe('account-scoped order rows adapt to the record row shape', () => {
  it('flattens the nested asset so the name is not lost', () => {
    // The bug this prevents: the record display helper reads `symbol`/`name`
    // flat, so an un-flattened row renders "-" for a name the server DID send.
    const item = toRecordOrderItem(accountOrderRow());

    assert.equal(item.symbol, '005930');
    assert.equal(item.name, '삼성전자');
    assert.equal(item.assetId, 'asset-1');
  });

  it('keeps the reservation fields an unfilled limit order is allowed to show', () => {
    const item = toRecordOrderItem(accountOrderRow());

    assert.equal(item.reservedAmount, '701400.00');
    assert.equal(item.limitPrice, '70000.00');
    // Execution-result amounts stay null on an order that never filled.
    assert.equal(item.executedPrice, undefined);
    assert.equal(item.grossAmount, null);
    assert.equal(item.netAmount, undefined);
  });

  it('is recognised by the open-limit-buy predicate the polling depends on', () => {
    const item = toRecordOrderItem(accountOrderRow());

    assert.equal(isOpenLimitBuyOrder(item), true);
  });

  it('handles a filled market row', () => {
    const item = toRecordOrderItem(
      accountOrderRow({
        orderType: 'market',
        status: 'executed',
        limitPrice: null,
        executedPrice: '71000.00',
        grossAmount: '710000.00',
        feeAmount: '1420.00',
        netAmount: '711420.00',
        reservedAmount: null,
        executedAt: '2026-08-04T01:00:05.000Z',
      }),
    );

    assert.equal(isOpenLimitBuyOrder(item), false);
    assert.equal(item.executedPrice, '71000.00');
    assert.equal(item.netAmount, '711420.00');
  });

  it('falls back to flat fields when the asset is absent', () => {
    const item = toRecordOrderItem({
      id: 'order-2',
      symbol: 'BTCUSDT',
      name: '비트코인',
      side: 'sell',
      quantity: '0.5',
    });

    assert.equal(item.orderId, 'order-2');
    assert.equal(item.symbol, 'BTCUSDT');
    assert.equal(item.name, '비트코인');
  });

  it('maps a whole page and tolerates an empty one', () => {
    assert.deepEqual(toRecordOrderItems(undefined), []);
    assert.deepEqual(
      toRecordOrderItems({
        state: 'available',
        tradingAccountId: 'acc-1',
        pagination: { limit: 20, offset: 0, total: 0, returned: 0, nextOffset: null },
        orders: [],
      }),
      [],
    );
    assert.equal(
      toRecordOrderItems({
        state: 'available',
        tradingAccountId: 'acc-1',
        pagination: { limit: 20, offset: 0, total: 1, returned: 1, nextOffset: null },
        orders: [accountOrderRow()],
      }).length,
      1,
    );
  });
});
