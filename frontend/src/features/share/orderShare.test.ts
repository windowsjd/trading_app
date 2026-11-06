import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getOrderShareTarget, resolveOrderShare } from './orderShare.ts';

const sell = (overrides: { order?: Record<string, unknown>; execution?: Record<string, unknown> } = {}) => ({
  order: { id: 'sell-1', assetId: 'asset-1', side: 'sell', orderType: 'market', status: 'executed', quantity: '10', ...overrides.order },
  execution: { state: 'executed', executedAt: '2026-11-06T01:00:00.000Z', ...overrides.execution },
}) as any;
const trade = (overrides: Record<string, unknown> = {}) => ({
  kind: 'spot', key: 'spot:asset-1', assetId: 'asset-1', symbol: '005930', name: '삼성전자', market: 'KRX',
  assetType: 'domestic_stock', currencyCode: 'KRW', buyAmount: '700700.00000000', realizedPnl: '49300.00000000',
  returnRate: '7.03582132', completedAt: '2026-11-06T01:00:00.000Z', lastSellOrderId: 'sell-1',
  averageBuyPrice: '70000.00000000', averageSellPrice: '75000.00000000', displayPriceDecimals: null, ...overrides,
});
const trades = (items: unknown[], tradingAccountId = 'account-1') => ({ tradingAccountId, items, hasMore: false }) as any;
const target = { accountId: 'account-1', orderId: 'sell-1', assetId: 'asset-1' };

describe('order success 공유하기 (orderShare)', () => {
  it('only an executed SELL with its order, asset and a filled quantity may offer it', () => {
    assert.deepEqual(getOrderShareTarget('account-1', sell()), target);
    // An idempotent replay of the same executed order is the same SELL.
    assert.deepEqual(getOrderShareTarget('account-1', sell({ execution: { state: 'already_executed' } })), target);
    assert.deepEqual(
      getOrderShareTarget('account-1', sell({ order: { id: undefined, orderId: 'sell-1', assetId: undefined, asset: { id: 'asset-1' } } })),
      target,
    );
    assert.deepEqual(
      getOrderShareTarget('account-1', sell({ order: { quantity: '10', marketExecution: { status: 'partial', executedQuantity: '4' } } })),
      target,
      'a partial market fill is still an executed SELL (the check decides)',
    );
    for (const [why, payload] of [
      ['a BUY', sell({ order: { side: 'buy' } })],
      ['an open limit SELL registration', sell({ order: { orderType: 'limit', status: 'submitted' }, execution: { state: 'submitted' } })],
      ['a LOC SELL registration', sell({ order: { orderType: 'limit', limitOnClose: { sessionDate: '2026-11-06' } }, execution: { state: 'submitted' } })],
      ['no order id', sell({ order: { id: undefined } })],
      ['no asset', sell({ order: { assetId: undefined } })],
      ['nothing filled', sell({ order: { marketExecution: { status: 'partial', executedQuantity: '0' } } })],
      ['no result', null],
    ] as const)
      assert.equal(getOrderShareTarget('account-1', payload as any) === null, true, why);
    assert.equal(getOrderShareTarget('', sell()) === null, true, 'no account');
  });

  it('is ready only with the completed trade this very SELL closed on this account and asset', () => {
    const ready = resolveOrderShare(target, trades([trade()]), '0');
    assert.equal(ready.state, 'ready');
    assert.equal(ready.state === 'ready' && ready.trade.key, 'spot:asset-1');
    for (const [why, list] of [
      ['an earlier round closed by another SELL', trades([trade({ lastSellOrderId: 'sell-0' })])],
      ['two SELLs at the closing instant (null)', trades([trade({ lastSellOrderId: null })])],
      ['an older server without the field', trades([trade({ lastSellOrderId: undefined })])],
      ['another asset', trades([trade({ assetId: 'asset-2', key: 'spot:asset-2' })])],
      ['another account’s answer', trades([trade()], 'account-2')],
      ['a futures lifetime', trades([{ kind: 'futures', key: 'futures:p', assetId: 'asset-1' }])],
      ['nothing completed', trades([])],
    ] as const)
      assert.equal(resolveOrderShare(target, list, '0').state, 'unverified', why);
  });

  it('a holding left after the SELL says so; an unknown holding never claims it', () => {
    assert.equal(resolveOrderShare(target, trades([]), '3.5').state, 'holding');
    assert.equal(resolveOrderShare(target, trades([trade({ lastSellOrderId: 'sell-0' })]), '0.00000001').state, 'holding');
    assert.equal(resolveOrderShare(target, trades([]), null).state, 'unverified');
    assert.equal(resolveOrderShare(target, trades([]), '0').state, 'unverified');
  });
});
