import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');

/**
 * The ordinary stock SELL 지정가 (2026-10-18; removed 2026-11-05, restored for
 * KRX/US stocks 2026-11-07 (3)) on the shared order form: offered only while
 * limits are registered and matched, it reserves the holding when accepted
 * (the server decides), so the form checks the unreserved part, whole shares,
 * and shows the expected gross, fee and proceeds. A crypto Spot SELL still has
 * no 지정가. A SELL limit accepted earlier stays in the one pending list with
 * its change and cancel; its reservation and fill are the server's, unchanged.
 * Assertions read small strings/booleans only.
 */
const qty = TEST_IDS.order.quantityInput;
const limitPrice = TEST_IDS.order.limitPriceInput;
const submit = TEST_IDS.order.executeSubmit;
const sell = TEST_IDS.assetDetail.sellButton;
const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const nodeText = (node: any): string | undefined => node ? [node.props.children].flat().join('') : undefined;
const value = (h: any, row: string) => nodeText(h.node(`${row}-value`));
const label = (h: any, row: string) => nodeText(h.node(row)?.findAll((n: any) => n.type === 'Text')[0]);
const rendered = (h: any): string => h.renderer.root
  .findAll((node: any) => node.type === 'Text')
  .map((node: any) => [node.props.children].flat().filter((child: unknown) => typeof child === 'string' || typeof child === 'number').join(''))
  .join('\n');
const has = (h: any, pattern: RegExp) => pattern.test(rendered(h));
const methods = (h: any) => ['market', 'limit', 'conditional', 'loc', 'protection']
  .filter((method) => h.node(`order-method-${method}`) !== undefined);
const matched = (accountId: string, autoExecutionEnabled = true) => ({ tradingAccountId: accountId,
  limitOrder: { enabled: true, autoExecutionEnabled },
  limitOnClose: { enabled: false, markets: [], sides: ['buy'], attachedProtection: false } });
const card = (h: any) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'pending-item-spot_limit-sell-1')[0];
function stock(h: any, marketStatus: string, accountId: string, assetType = 'domestic_stock') {
  h.accountId = accountId;
  h.assetId = 'samsung';
  h.assets.samsung.assetType = assetType;
  h.assets.samsung.marketStatus = marketStatus;
  h.assets.samsung.tradable = marketStatus === 'open';
  h.orderCapabilities = matched(accountId);
  h.positions[accountId] = '10';
  h.positionAvailable = { [accountId]: '6' };
  h.positionReserved = { [accountId]: '4' };
}

describe('SELL 지정가 per market', () => {
  for (const [assetId, assetType, expected] of [
    ['samsung', 'domestic_stock', ['market', 'limit', 'conditional', 'loc']],
    ['samsung', 'us_stock', ['market', 'limit', 'conditional', 'loc']],
    ['bnb', 'crypto', ['market', 'conditional']],
  ] as const)
    for (const accountId of ['general', 'season'])
      it(`${accountId} ${assetType}: limits registered and matched list ${(expected as readonly string[]).includes('limit') ? 'a' : 'no'} SELL 지정가; BUY keeps it`, async (t) => {
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
});

describe('SELL limit (stocks)', () => {
  for (const [accountId, assetType] of [['general', 'domestic_stock'], ['season', 'domestic_stock'], ['general', 'us_stock']] as const)
    it(`${accountId} ${assetType}: only the unreserved holding, whole shares, expected proceeds; quote then create, accepted not filled`, async (t) => {
      const h = inlineTradingHarness();
      stock(h, 'open', accountId, assetType);
      h.method = null;
      await h.mount(); t.after(h.close);
      await h.press(sell);
      await h.selectOrderType('limit');
      assert.equal(h.orderType(), '지정가');
      // What a new sell can use: holding 10 − 4 reserved by other orders.
      assert.deepEqual([value(h, 'order-sell-capacity'), value(h, 'order-sell-reserved')], ['6주', '4주']);
      await h.input(limitPrice, assetType === 'us_stock' ? '71' : '71000');
      await h.press('order-ratio-100');
      assert.equal(h.node(qty).props.value, '6', '100% is the unreserved part, in whole shares');
      await h.press('order-ratio-25');
      assert.equal(h.node(qty).props.value, '1');
      await h.input(qty, '6');
      assert.equal(nodeText(h.node('order-summary-badge')), '체결 대기');
      assert.equal(label(h, 'order-summary-total'), '예상 수령액');
      if (assetType === 'domestic_stock') {
        // 71,000 × 6 = 426,000; fee 0.1 % = 426; proceeds 425,574.
        assert.deepEqual([value(h, 'order-summary-price'), value(h, 'order-summary-quantity'), value(h, 'order-summary-fee'),
          value(h, 'order-summary-total')], ['71,000원', '6주', '426원', '425,574원']);
      }
      // Above the unreserved part: refused before any request.
      await h.input(qty, '7');
      assert.equal(has(h, /매도 가능 수량을 초과했습니다\. 다른 주문이 예약한 수량은 매도할 수 없습니다\./), true);
      assert.equal(h.node(submit).props.state, 'disabled');
      // A stock limit takes whole shares only.
      await h.input(qty, '2.5');
      assert.equal(has(h, /지정가는 정수 수량을 입력해주세요/), true);
      assert.equal(h.node(submit).props.state, 'disabled');
      await h.input(qty, '6');
      assert.equal(h.node(submit).props.state, 'enabled');
      await h.press(submit); await h.flush();
      assert.deepEqual(h.requests.map((request: any) => request.url),
        [`/trading-accounts/${accountId}/orders/quote`, `/trading-accounts/${accountId}/orders`]);
      for (const request of h.requests)
        assert.deepEqual([request.body.side, request.body.orderType, request.body.limitPrice, request.body.quantity, request.body.amount],
          ['sell', 'limit', assetType === 'us_stock' ? '71' : '71000', '6', undefined]);
      assert.equal('limitOnClose' in h.requests[1].body, false, 'an ordinary limit, never LOC');
      assert.equal('entryTpSl' in h.requests[1].body, false, 'a SELL has no entry plans');
      assert.equal(h.success().visible, true);
      assert.equal(h.success().payload.execution.state, 'submitted', 'accepted, not filled');
    });

  it('closed KRX: the session notice suggests 지정가, and a SELL limit waits for the next regular session', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'closed', 'general');
    h.method = null;
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.input(qty, '1');
    assert.equal(has(h, /지정가를 선택하면 다음 정규장을 기다리는 주문을 등록할 수 있습니다/), true);
    await h.selectOrderType('limit');
    await h.input(limitPrice, '71000');
    await h.input(qty, '3');
    assert.equal(nodeText(h.node('order-summary-badge')), '정규장 대기');
    assert.equal(h.node(submit).props.state, 'enabled');
  });

  it('automatic matching off: the SELL limit is listed but cannot be chosen, and a closed market suggests nothing', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'closed', 'general');
    h.orderCapabilities = matched('general', false);
    h.method = null;
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.input(qty, '1');
    assert.equal(has(h, /정규장 외에는 시장가 주문을 할 수 없습니다\. 정규장에 다시 주문해주세요/), true);
    assert.equal(has(h, /지정가를 선택하면/), false);
    await h.press(TEST_IDS.order.typeSelect);
    assert.equal(h.node('order-method-limit').props.disabled, true);
    assert.equal(has(h, /지금은 지정가 주문이 자동 체결되지 않아 지정가 매도를 접수할 수 없어요/), true);
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
