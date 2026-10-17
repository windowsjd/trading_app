import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');

/**
 * The ordinary SELL limit (2026-10-18) on the shared order form: offered
 * only while limits are registered and matched, it reserves the holding when
 * accepted (the server decides), so the form checks the unreserved part,
 * whole shares for stocks, and shows the expected gross, fee and proceeds.
 * Assertions read small strings/booleans only.
 */
const qty = TEST_IDS.order.quantityInput;
const limitPrice = TEST_IDS.order.limitPriceInput;
const submit = TEST_IDS.order.executeSubmit;
const sell = TEST_IDS.assetDetail.sellButton;
const text = (node: any): string | undefined => node ? [node.props.children].flat().join('') : undefined;
const value = (h: any, row: string) => text(h.node(`${row}-value`));
const label = (h: any, row: string) => text(h.node(row)?.findAll((n: any) => n.type === 'Text')[0]);
const rendered = (h: any): string => h.renderer.root
  .findAll((node: any) => node.type === 'Text')
  .map((node: any) => [node.props.children].flat().filter((child: unknown) => typeof child === 'string' || typeof child === 'number').join(''))
  .join('\n');
const has = (h: any, pattern: RegExp) => pattern.test(rendered(h));
const matched = (accountId: string) => ({ tradingAccountId: accountId, limitOrder: { enabled: true, autoExecutionEnabled: true },
  limitOnClose: { enabled: false, markets: [], sides: ['buy'], attachedProtection: false } });
function stock(h: any, marketStatus: string, accountId: string) {
  h.accountId = accountId;
  h.assetId = 'samsung';
  h.assets.samsung.marketStatus = marketStatus;
  h.assets.samsung.tradable = marketStatus === 'open';
  h.orderCapabilities = matched(accountId);
  h.positions[accountId] = '10';
  h.positionAvailable = { [accountId]: '6' };
  h.positionReserved = { [accountId]: '4' };
}

describe('SELL limit (stocks)', () => {
  for (const accountId of ['general', 'season'])
    it(`${accountId} KRX: expected gross, fee and proceeds; only the unreserved holding; whole shares; quote then create`, async (t) => {
      const h = inlineTradingHarness();
      stock(h, 'open', accountId);
      h.method = null;
      await h.mount(); t.after(h.close);
      await h.press(sell);
      await h.selectOrderType('limit');
      assert.equal(h.orderType(), '지정가');
      // What a new sell can use: holding 10 − 4 reserved by other orders.
      assert.deepEqual([value(h, 'order-sell-capacity'), value(h, 'order-sell-reserved')], ['6주', '4주']);
      await h.input(limitPrice, '71000');
      await h.press('order-ratio-100');
      assert.equal(h.node(qty).props.value, '6', '100% is the unreserved part, in whole shares');
      await h.press('order-ratio-25');
      assert.equal(h.node(qty).props.value, '1');
      await h.input(qty, '6');
      assert.deepEqual([text(h.node('order-summary-badge')), value(h, 'order-summary-price'), value(h, 'order-summary-quantity')],
        ['체결 대기', '71,000원', '6주']);
      // 71,000 × 6 = 426,000; fee 0.1 % = 426; proceeds 425,574.
      assert.deepEqual([value(h, 'order-summary-fee'), label(h, 'order-summary-total'), value(h, 'order-summary-total')],
        ['426원', '예상 수령액', '425,574원']);
      assert.deepEqual([label(h, 'order-summary-after'), value(h, 'order-summary-after')], ['주문 후 매도 가능', '0주']);
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
      assert.equal(h.requests.length, 2);
      assert.equal(h.requests[0].url, `/trading-accounts/${accountId}/orders/quote`);
      assert.equal(h.requests[1].url, `/trading-accounts/${accountId}/orders`);
      for (const request of h.requests)
        assert.deepEqual([request.body.side, request.body.orderType, request.body.limitPrice, request.body.quantity, request.body.amount],
          ['sell', 'limit', '71000', '6', undefined]);
      assert.equal('limitOnClose' in h.requests[1].body, false, 'an ordinary limit, never LOC');
      assert.equal('entryTpSl' in h.requests[1].body, false, 'a SELL has no entry plans');
      assert.equal(h.success().visible, true);
      assert.equal(h.success().payload.execution.state, 'submitted', 'accepted, not filled');
    });

  it('closed KRX: a SELL limit waits for the next regular session', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'closed', 'general');
    h.method = null;
    await h.mount(); t.after(h.close);
    await h.press(sell);
    assert.equal(has(h, /지정가를 선택하면 다음 정규장을 기다리는 주문을 등록할 수 있습니다/), true);
    await h.selectOrderType('limit');
    await h.input(limitPrice, '71000');
    await h.input(qty, '3');
    assert.equal(text(h.node('order-summary-badge')), '정규장 대기');
    assert.equal(h.node(submit).props.state, 'enabled');
  });

  it('automatic matching off: the SELL limit is listed but cannot be chosen', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'open', 'general');
    h.orderCapabilities = { ...matched('general'), limitOrder: { enabled: true, autoExecutionEnabled: false } };
    h.method = null;
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.press(TEST_IDS.order.typeSelect);
    assert.equal(h.node('order-method-limit').props.disabled, true);
    assert.equal(has(h, /지금은 지정가 주문이 자동 체결되지 않아 지정가 매도를 접수할 수 없어요/), true);
  });
});

describe('SELL limit (crypto)', () => {
  it('shows the expected order amount, fee and proceeds from the entered limit price', async (t) => {
    const h = inlineTradingHarness();
    h.orderCapabilities = matched('general');
    h.positions.general = '4';
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.selectOrderType('limit');
    await h.input(limitPrice, '800');
    await h.input(qty, '0.5');
    const preview = h.node('order-indicative-preview');
    assert.equal(preview !== undefined, true);
    const rows = preview.findAll((n: any) => n.type === 'Text').map((n: any) => text(n));
    // 800 × 0.5 = 400; fee 0.1 % = 0.4; proceeds 399.6.
    assert.deepEqual(rows, ['예상 주문금액', '$400', '예상 수수료', '$0.4', '예상 수령액', '$399.6']);
    await h.press(submit); await h.flush();
    assert.equal(h.requests.length, 2);
    assert.deepEqual([h.requests[1].body.side, h.requests[1].body.orderType, h.requests[1].body.limitPrice, h.requests[1].body.quantity],
      ['sell', 'limit', '800', '0.5']);
  });
});
