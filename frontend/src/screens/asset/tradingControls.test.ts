import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const { inlineTradingHarness, deferred, act } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const qty = TEST_IDS.order.quantityInput,
  submit = TEST_IDS.order.executeSubmit;
const text = (h: any) => JSON.stringify(h.renderer.toJSON());

for (const side of ['buy', 'sell']) {
  test(`${side}: market/limit transitions clear stale actions and strip market limitPrice`, async (t) => {
    const h = inlineTradingHarness();
    await h.mount();
    t.after(h.close);
    if (side === 'sell') await h.press(TEST_IDS.assetDetail.sellButton);
    assert.equal(h.node(TEST_IDS.order.quoteSubmit), undefined);
    assert.equal(h.node(submit).props.label, side === 'buy' ? '매수' : '매도');
    await h.input(qty, '1');
    h.failure = new Error('response lost');
    await h.press(submit);
    await h.flush();
    await h.press(TEST_IDS.order.typeToggleLimit);
    assert.equal(
      h.node(TEST_IDS.order.typeToggleLimit).props.accessibilityState.selected,
      true,
    );
    await h.input(TEST_IDS.order.limitPriceInput, '100');
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests[2].body.orderType, 'limit');
    assert.equal(h.requests[3].body.limitPrice, '100');
    await h.press(TEST_IDS.order.typeToggleMarket);
    assert.equal(h.node(TEST_IDS.order.limitPriceInput), undefined);
    h.failure = null;
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests[4].body.orderType, undefined);
    assert.equal(h.requests[5].body.limitPrice, undefined);
    assert.equal(
      h.requests.filter((r: any) => r.url.endsWith('/quote')).length,
      3,
    );
    assert.equal(
      new Set(
        h.requests
          .filter((r: any) => !r.url.endsWith('/quote'))
          .map((r: any) => r.body.idempotencyKey),
      ).size,
      3,
    );
  });
  test(`${side}: quote failure never creates; user may explicitly retry`, async (t) => {
    const h = inlineTradingHarness();
    h.quoteFailure = {
      response: { data: { error: { code: 'PRICE_UNAVAILABLE' } } },
    };
    await h.mount();
    t.after(h.close);
    if (side === 'sell') await h.press(TEST_IDS.assetDetail.sellButton);
    await h.input(qty, '1');
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.success().visible, false);
    h.quoteFailure = null;
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests.length, 3);
  });
}
for (const assetId of ['bnb', 'samsung']) {
  test(`${assetId}: all buy ratios fill from available wallet with existing fee buffer`, async (t) => {
    const h = inlineTradingHarness();
    h.assetId = assetId;
    h.usdBalance = '100.2';
    h.usdReserved = '0';
    h.krwBalance = '100.2';
    h.assets[assetId].price.currentPrice = '100';
    await h.mount();
    t.after(h.close);
    for (const percent of [25, 50, 75, 100]) {
      await h.press(`order-ratio-${percent}`);
      assert.equal(h.node(qty).props.value, String(percent / 100));
    }
  });
}
test('all sell ratios use selected position and empty holdings stays quiet until input or ratio press', async (t) => {
  const h = inlineTradingHarness();
  await h.mount();
  t.after(h.close);
  await h.press(TEST_IDS.assetDetail.sellButton);
  for (const percent of [25, 50, 75, 100]) {
    await h.press(`order-ratio-${percent}`);
    assert.equal(h.node(qty).props.value, String(percent / 25));
  }
  h.positions.general = '0';
  await h.input(qty, '');
  await h.update();
  assert.doesNotMatch(text(h), /보유 수량이 없어 매도할 수 없습니다/);
  assert.equal(h.node(submit).props.state, 'disabled');
  await h.press('order-ratio-100');
  assert.match(text(h), /보유 수량이 없습니다/);
  assert.equal(h.node(qty).props.value, '');
  await h.input(qty, '1');
  assert.match(text(h), /보유 수량이 없어 매도할 수 없습니다/);
  h.positions.general = '1';
  await h.input(qty, '2');
  await h.update();
  assert.match(text(h), /보유 수량을 초과/);
});
for (const scenario of ['zero', 'wallet', 'price', 'limit', 'position']) {
  test(`ratio ${scenario}: press explains inability without inventing quantity`, async (t) => {
    const h = inlineTradingHarness();
    if (scenario === 'zero') {
      h.usdBalance = '0';
      h.usdReserved = '0';
    }
    if (scenario === 'wallet') h.walletState = { isError: true };
    if (scenario === 'price') h.assets.bnb.price = { state: 'unavailable' };
    if (scenario === 'position') h.positionState = { isError: true };
    await h.mount();
    t.after(h.close);
    if (scenario === 'position') await h.press(TEST_IDS.assetDetail.sellButton);
    if (scenario === 'limit') await h.press(TEST_IDS.order.typeToggleLimit);
    assert.equal(h.node('order-ratio-25').props.disabled, false);
    await h.press('order-ratio-25');
    assert.equal(h.node(qty).props.value, '');
    const expected = {
      zero: 'USD 사용 가능 잔액이 없습니다',
      wallet: '지갑 잔액을 확인할 수 없습니다',
      price: '현재가가 없어 비율 수량을 계산할 수 없습니다',
      limit: '지정가를 입력하면 비율 수량을 계산할 수 있습니다',
      position: '보유 수량을 확인할 수 없습니다',
    };
    assert.ok(text(h).includes(expected[scenario]));
    assert.equal(h.requests.length, 0);
  });
}
for (const quantity of ['1', '4'])
  test(`sell quantity ${quantity}: partial/full holding and canonical quote strings`, async (t) => {
    const h = inlineTradingHarness();
    h.quoteOverride = {
      quantity: quantity + '.000000',
      limitPrice: '100.00000000',
    };
    await h.mount();
    t.after(h.close);
    await h.press(TEST_IDS.assetDetail.sellButton);
    await h.press(TEST_IDS.order.typeToggleLimit);
    await h.input(TEST_IDS.order.limitPriceInput, '100');
    await h.input(qty, quantity);
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests[1].body.quantity, quantity + '.000000');
    assert.equal(h.requests[1].body.limitPrice, '100.00000000');
  });
for (const mismatch of [
  { asset: { id: 'other' } },
  { side: 'buy' },
  { quantity: '2' },
  { orderType: 'limit' },
  { tradingAccountId: 'other' },
])
  test(`sell quote binding rejects ${JSON.stringify(mismatch)}`, async (t) => {
    const h = inlineTradingHarness();
    h.quoteOverride = mismatch;
    await h.mount();
    t.after(h.close);
    await h.press(TEST_IDS.assetDetail.sellButton);
    await h.input(qty, '1');
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.success().visible, false);
  });
test('sell uncertain create preserves quote and idempotency key across an explicit retry', async (t) => {
  const h = inlineTradingHarness();
  h.failure = new Error('response lost');
  await h.mount();
  t.after(h.close);
  await h.press(TEST_IDS.assetDetail.sellButton);
  await h.input(qty, '1');
  await h.press(submit);
  await h.flush();
  h.failure = null;
  await h.press(submit);
  await h.flush();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests[1], h.requests[2]);
});
for (const role of ['user', 'operator', 'admin'])
  for (const screen of ['detail', 'chart'])
    test(`${role} ${screen} technical warnings respect role; product notices remain`, async (t) => {
      const h = inlineTradingHarness();
      h.role = role;
      h.reconnect = true;
      h.tickerStale = true;
      h.candleStale = true;
      h.candle = { delayed: true };
      if (screen === 'chart') h.Screen = h.Chart;
      await h.mount();
      t.after(h.close);
      assert.equal(
        /실시간 연결 복구|실시간 시세 최신성|실시간 캔들 지연/.test(text(h)),
        role === 'admin',
      );
      if (screen === 'chart')
        assert.match(text(h), /미국 캔들은 KIS 지연 체결 피드/);
    });
test('double click during sell quote and unmount never start create', async (t) => {
  const h = inlineTradingHarness();
  h.quoteGate = deferred();
  await h.mount();
  await h.press(TEST_IDS.assetDetail.sellButton);
  await h.input(qty, '1');
  const press = h.node(submit).props.onPress;
  await act(async () => {
    press();
    press();
  });
  assert.equal(h.requests.length, 1);
  await h.close();
  await act(async () => h.quoteGate.resolve());
  await h.flush();
  assert.equal(h.requests.length, 1);
});

// An HTTP 200 unavailable section must not authorize using retained quantities.
test('sell unavailable position section explains ratio failure and blocks create', async (t) => {
  const h = inlineTradingHarness();
  h.positionDataState = 'unavailable';
  await h.mount();
  t.after(h.close);
  await h.press(TEST_IDS.assetDetail.sellButton);
  await h.press('order-ratio-100');
  assert.match(text(h), /보유 수량을 확인할 수 없습니다/);
  assert.equal(h.node(qty).props.value, '');
  await h.input(qty, '1');
  assert.equal(h.node(submit).props.state, 'disabled');
  await h.press(submit);
  assert.equal(h.requests.length, 0);
});
