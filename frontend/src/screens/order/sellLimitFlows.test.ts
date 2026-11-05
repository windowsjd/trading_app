import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');

/**
 * No new spot SELL 지정가 (2026-11-05): every spot market's SELL 주문방식
 * lists 시장가, 조건주문 and (stocks) LOC — even while limits are registered
 * and matched — and a closed stock market no longer suggests a limit. A SELL
 * limit accepted earlier stays in the one pending list with its change and
 * cancel; its reservation and fill are the server's, unchanged.
 * Assertions read small strings/booleans only.
 */
const sell = TEST_IDS.assetDetail.sellButton;
const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const json = (h: any) => JSON.stringify(h.renderer.toJSON());
const methods = (h: any) => ['market', 'limit', 'conditional', 'loc', 'protection']
  .filter((method) => h.node(`order-method-${method}`) !== undefined);
const matched = (accountId: string) => ({ tradingAccountId: accountId, limitOrder: { enabled: true, autoExecutionEnabled: true },
  limitOnClose: { enabled: false, markets: [], sides: ['buy'], attachedProtection: false } });
const card = (h: any) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'pending-item-spot_limit-sell-1')[0];

describe('no new SELL 지정가', () => {
  for (const [assetId, assetType, expected] of [
    ['samsung', 'domestic_stock', ['market', 'conditional', 'loc']],
    ['samsung', 'us_stock', ['market', 'conditional', 'loc']],
    ['bnb', 'crypto', ['market', 'conditional']],
  ] as const)
    for (const accountId of ['general', 'season'])
      it(`${accountId} ${assetType}: limits registered and matched still list no SELL 지정가; BUY keeps it`, async (t) => {
        const h = inlineTradingHarness();
        h.method = null;
        h.accountId = accountId;
        h.assetId = assetId;
        h.assets[assetId].assetType = assetType;
        h.orderCapabilities = matched(accountId);
        h.positions[accountId] = '10';
        await h.mount(); t.after(h.close);
        await h.press(TEST_IDS.order.typeSelect);
        assert.equal(h.node('order-method-limit') !== undefined, true, 'BUY 지정가');
        await h.press('order-method-market');
        await h.press(sell);
        await h.press(TEST_IDS.order.typeSelect);
        assert.deepEqual(methods(h), expected);
        await h.press('order-method-market');
        assert.equal(h.orderType(), '시장가');
      });

  it('closed KRX: the SELL session notice no longer suggests 지정가, whatever the limit gates say', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.assetId = 'samsung';
    h.assets.samsung.marketStatus = 'closed';
    h.orderCapabilities = matched('general');
    h.positions.general = '10';
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.input(TEST_IDS.order.quantityInput, '1');
    assert.match(json(h), /정규장 외에는 시장가 주문을 할 수 없습니다. 정규장에 다시 주문해주세요/);
    assert.doesNotMatch(json(h), /지정가를 선택하면/);
  });
});

describe('a SELL limit accepted earlier', () => {
  it('stays in the one pending list: changed in place by ONE modify, and still cancelable', async (t) => {
    const h = inlineTradingHarness();
    t.after(h.close);
    h.orders = { general: [{ id: 'sell-1', orderId: 'sell-1', side: 'sell', orderType: 'limit', status: 'submitted', quantity: '2',
      limitPrice: '900', currencyCode: 'USD', revision: 3, submittedAt: '2026-09-29T01:00:00.000Z',
      asset: { id: 'eth', symbol: 'ETHUSDT', name: 'ETH', market: 'BINANCE' } }] };
    await h.mount(); await h.press('holdings-filter-pending');
    for (let i = 0; i < 20 && !card(h); i += 1) await h.flush();
    assert.equal(text(h.node('pending-item-spot_limit-sell-1-type')), '지정가');
    assert.match(text(card(h)), /매도/);
    assert.match(text(h.node('pending-item-spot_limit-sell-1-amount')), /\$1,800 \(2 ETH\)/);
    await h.press('pending-item-spot_limit-sell-1-edit');
    assert.equal(h.node('pending-edit-quantity')?.props.value, '2');
    assert.equal(h.node('pending-edit-quantity-ratio') === undefined, true, 'no holding share on an ordinary limit');
    await h.input('pending-edit-limit-price', '950');
    await h.press('pending-edit-review');
    await h.press('pending-edit-save'); await h.flush();
    const sent = h.requests.filter((request: any) => request.url.endsWith('/modify'));
    assert.deepEqual(sent.map((request: any) => request.url), ['/trading-accounts/general/orders/sell-1/modify']);
    assert.deepEqual({ ...sent[0].body, idempotencyKey: typeof sent[0].body.idempotencyKey },
      { limitPrice: '950', quantity: '2', expectedRevision: 3, idempotencyKey: 'string' });
    assert.equal(h.requests.some((request: any) => request.url.endsWith('/orders')), false, 'never a new order');
    await h.press('pending-item-spot_limit-sell-1-cancel');
    // One short question naming the order; no reservation explanation.
    assert.match(text(h.node('pending-item-spot_limit-sell-1-confirm')), /^지정가 매도 주문을 취소할까요\?유지취소하기$/);
    await h.press('pending-item-spot_limit-sell-1-confirm-cancel'); await h.flush();
    assert.deepEqual(h.requests.filter((request: any) => request.url.endsWith('/cancel')).map((request: any) => request.url),
      ['/trading-accounts/general/orders/sell-1/cancel']);
  });
});
