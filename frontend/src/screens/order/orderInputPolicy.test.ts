import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Decimal from 'decimal.js';
import { TEST_IDS } from '../../constants/testIds.ts';
const { inlineTradingHarness, deferred } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const input = TEST_IDS.order.quantityInput;
const submit = TEST_IDS.order.executeSubmit;
const json = (h: any) => JSON.stringify(h.renderer.toJSON());

for (const accountId of ['general', 'season']) {
  for (const orderType of ['market', 'limit']) {
    test(`${accountId} crypto BUY ${orderType}: amount is the request intent and quoted quantity is authoritative`, async (t) => {
      const h = inlineTradingHarness();
      h.accountId = accountId;
      h.createGate = deferred();
      h.quoteOverride = { quantity: '0.142857', amount: '100.00000000' };
      await h.mount();
      t.after(h.close);
      if (orderType === 'limit') {
        await h.selectOrderType('limit');
        await h.input(TEST_IDS.order.limitPriceInput, '700');
      }
      assert.match(h.node(input).props.accessibilityLabel, /매수 금액 USD/);
      await h.input(input, '100');
      assert.match(json(h), /매수 원금|예상 수량/);
      await h.press(submit);
      await h.flush();
      assert.equal(h.requests.length, 2);
      for (const r of h.requests) {
        assert.equal(r.body.amount, '100');
        assert.equal(r.body.quantity, undefined);
      }
      assert.match(json(h), /0.142857/);
      h.createGate.resolve();
      await h.flush();
      assert.equal(h.success().quote.quantity, '0.142857');
    });
  }
  for (const assetType of ['domestic_stock', 'us_stock']) {
    for (const side of ['buy', 'sell']) {
      test(`${accountId} ${assetType} ${side}: fractional market, integer-only limit and no automatic type switch`, async (t) => {
        const h = inlineTradingHarness();
        h.accountId = accountId;
        h.assetId = 'samsung';
        h.assets.samsung.assetType = assetType;
        h.assets.samsung.marketStatus = 'closed';
        await h.mount();
        t.after(h.close);
        if (side === 'sell') await h.press(TEST_IDS.assetDetail.sellButton);
        await h.input(input, '0.5');
        assert.notEqual(h.node(submit).props.state, 'disabled');
        assert.match(json(h), /정규장 외에는 시장가 주문을 할 수 없습니다/);
        assert.equal(h.orderType(), '시장가');
        await h.selectOrderType('limit');
        await h.input(TEST_IDS.order.limitPriceInput, '70000');
        assert.equal(h.node(submit).props.state, 'disabled');
        assert.match(json(h), /소수점 수량은 시장가만/);
        await h.press(submit);
        assert.equal(h.requests.length, 0);
        await h.input(input, '1.000000');
        assert.notEqual(h.node(submit).props.state, 'disabled');
        await h.press(submit);
        await h.flush();
        assert.equal(h.requests[0].body.quantity, '1.000000');
        assert.equal(h.requests[0].body.amount, undefined);
        assert.equal(h.success().payload.execution.state, 'submitted');
      });
    }
  }
}
for (const failure of ['missing-price', 'stale-price', 'fee']) {
  test(`stock manual input still requests server Quote when preview has ${failure}`, async (t) => {
    const h = inlineTradingHarness();
    h.assetId = 'samsung';
    h.assets.samsung.marketStatus = 'open';
    if (failure === 'missing-price')
      h.assets.samsung.price = { state: 'unavailable' };
    if (failure === 'stale-price')
      h.assets.samsung.price.priceCapturedAt = new Date(
        Date.now() - 120000,
      ).toISOString();
    if (failure === 'fee') h.feeRate = 'invalid';
    await h.mount();
    t.after(h.close);
    await h.input(input, '2');
    assert.notEqual(h.node(submit).props.state, 'disabled');
    if (failure !== 'fee')
      assert.equal(h.node('order-quantity-slider').props.disabled, true);
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].body.quantity, '2');
  });
}
for (const code of [
  'PRICE_UNAVAILABLE',
  'PRICE_STALE',
  'MARKET_CLOSED',
  'MARKET_CALENDAR_UNAVAILABLE',
]) {
  test(`manual stock input receives ${code} from Backend without preview blocking Quote`, async (t) => {
    const h = inlineTradingHarness();
    h.assetId = 'samsung';
    h.assets.samsung.price = { state: 'unavailable' };
    h.quoteFailure = { response: { data: { error: { code } } } };
    await h.mount();
    t.after(h.close);
    await h.input(input, '2');
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.success().visible, false);
    assert.ok(
      h.renderer.root.findAll(
        (n: any) => n.props.accessibilityLiveRegion === 'polite',
      ).length,
    );
  });
}
test('crypto amount ratios need cash and actual fee, not a price, and 100% covers fees', async (t) => {
  const h = inlineTradingHarness();
  h.usdAvailable = '100';
  h.feeRate = '0.003';
  h.assets.bnb.price = { state: 'unavailable' };
  await h.mount();
  t.after(h.close);
  await h.press('order-ratio-100');
  const amount = new Decimal(h.node(input).props.value);
  const fee = amount.mul('0.003').toDecimalPlaces(8);
  assert.equal(amount.toFixed(8), '99.70089730');
  assert.ok(amount.add(fee).lte('100'));
  await h.selectOrderType('limit');
  await h.press('order-ratio-50');
  assert.equal(h.node(input).props.value, '49.85044865');
  assert.equal(h.requests.length, 0);
});
test('a quote for another amount cannot create, while a server quantity differing from preview can', async (t) => {
  const h = inlineTradingHarness();
  h.quoteOverride = { amount: '101', quantity: '9' };
  await h.mount();
  t.after(h.close);
  await h.input(input, '100');
  await h.press(submit);
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.match(json(h), /견적이 일치하지 않습니다/);
});

for (const quantity of ['0', '-1', 'NaN', 'Infinity']) {
  test(`crypto amount quote with invalid quantity ${quantity} cannot create`, async (t) => {
    const h = inlineTradingHarness();
    h.quoteOverride = { amount: '100', quantity };
    await h.mount();
    t.after(h.close);
    await h.input(input, '100');
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.match(json(h), /견적이 일치하지 않습니다/);
  });
}
