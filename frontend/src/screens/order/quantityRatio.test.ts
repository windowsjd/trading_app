import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const { inlineTradingHarness, deferred } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const qty = TEST_IDS.order.quantityInput;
const slider = 'order-quantity-slider';
const flatten = (style: any): any =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};
const selected = (h: any) =>
  [25, 50, 75, 100].filter(
    (percent) =>
      h.node(`order-ratio-${percent}`).props.accessibilityState.selected,
  );
const json = (h: any) => JSON.stringify(h.renderer.toJSON());

for (const screen of ['inline', 'standalone'])
  for (const account of ['general', 'season'])
    for (const side of ['buy', 'sell'])
      for (const type of ['market', 'limit'])
        test(`${screen} ${account} ${side} ${type}: presets and slider share quantity policy and selection`, async (t) => {
          const h = inlineTradingHarness();
          if (screen === 'standalone') h.Screen = h.OrderScreen;
          h.accountId = account;
          h.usdBalance = '1100.2';
          h.usdReserved = '1000'; // Only 100.2 is available, including the existing buffer.
          h.usdAvailable = '100.2'; // Server-computed spendable amount in the real wallet DTO.
          h.assets.bnb.price.currentPrice = '100';
          await h.mount();
          t.after(h.close);
          if (side === 'sell') await h.press(TEST_IDS.assetDetail.sellButton);
          if (type === 'limit') {
            await h.press(TEST_IDS.order.typeToggleLimit);
            await h.input(TEST_IDS.order.limitPriceInput, '50');
          }
          const capacity =
            side === 'buy'
              ? type === 'limit'
                ? 2
                : 1
              : Number(h.positions[account]);
          for (const percent of [25, 50, 75, 100]) {
            await h.press(`order-ratio-${percent}`);
            const expected = String(
              Math.floor(((capacity * percent) / 100) * 1e6) / 1e6,
            );
            assert.equal(h.node(qty).props.value, expected);
            assert.equal(h.node(slider).props.value, percent);
            assert.deepEqual(selected(h), [percent]);
            for (const other of [25, 50, 75, 100]) {
              const button = h.node(`order-ratio-${other}`);
              assert.equal(
                flatten(button.props.style).backgroundColor,
                other === percent ? '#202a35' : undefined,
              );
              const label = button.findByType('Text');
              assert.equal(
                flatten(label.props.style).color,
                other === percent ? '#fff' : '#354251',
              );
            }
            await h.slide(percent);
            assert.equal(h.node(qty).props.value, expected);
          }
          await h.slide(37);
          assert.equal(h.node(qty).props.value, String(capacity * 0.37));
          assert.equal(h.node(slider).props.value, 37);
          assert.deepEqual(selected(h), []);
          await h.slide(50);
          assert.deepEqual(selected(h), [50]);
          await h.input(qty, String(capacity * 0.6));
          assert.equal(h.node(slider).props.value, 60);
          assert.deepEqual(selected(h), []);
          await h.input(qty, String(capacity * 2));
          assert.equal(h.node(slider).props.value, 100);
          assert.deepEqual(selected(h), []);
          await h.slide(0);
          assert.equal(h.node(qty).props.value, '');
          assert.equal(h.node(slider).props.value, 0);
          assert.deepEqual(selected(h), []);
          assert.equal(
            h.node(TEST_IDS.order.executeSubmit).props.state,
            'disabled',
          );
          assert.doesNotMatch(
            json(h),
            /0보다 큰 수량|수량을 입력해주세요|계산된 수량이 너무 작습니다/,
          );
          await h.slide(-10);
          assert.equal(h.node(qty).props.value, '');
          await h.slide(110);
          assert.equal(h.node(qty).props.value, String(capacity));
          await h.slide(NaN);
          assert.equal(h.node(qty).props.value, String(capacity));
          assert.equal(h.requests.length, 0);
        });

test('six-decimal flooring preserves the selected ratio; rejected tiny quantity does not move the controls', async (t) => {
  const h = inlineTradingHarness();
  h.positions.general = '0.000007';
  await h.mount();
  t.after(h.close);
  await h.press(TEST_IDS.assetDetail.sellButton);
  await h.press('order-ratio-50');
  assert.equal(h.node(qty).props.value, '0.000003');
  assert.equal(h.node(slider).props.value, 50);
  await h.slide(1);
  assert.equal(h.node(qty).props.value, '0.000003');
  assert.deepEqual(selected(h), [50]);
  assert.match(json(h), /계산된 수량이 너무 작습니다/);
  await h.input(qty, '0.000003');
  assert.equal(h.node(slider).props.value, 43);
  assert.deepEqual(selected(h), []);
  await h.slide(0);
  assert.doesNotMatch(json(h), /계산된 수량이 너무 작습니다/);
});

test('manual edits, price, reservations, limit changes and side/account changes never retain stale selection', async (t) => {
  const h = inlineTradingHarness();
  h.usdBalance = '100.2';
  h.usdReserved = '0';
  h.usdAvailable = '100.2';
  h.assets.bnb.price.currentPrice = '100';
  await h.mount();
  t.after(h.close);
  await h.press('order-ratio-50');
  h.assets.bnb = {
    ...h.assets.bnb,
    price: { ...h.assets.bnb.price, currentPrice: '200' },
  };
  await h.update();
  assert.equal(h.node(qty).props.value, '0.5');
  assert.equal(h.node(slider).props.value, 100);
  assert.deepEqual(selected(h), []);
  await h.press('order-ratio-50');
  h.usdReserved = '50.1';
  h.usdAvailable = '50.1';
  await h.update();
  assert.equal(h.node(qty).props.value, '0.25');
  assert.equal(h.node(slider).props.value, 100);
  assert.deepEqual(selected(h), []);
  await h.press(TEST_IDS.order.typeToggleLimit);
  assert.equal(h.node(slider).props.disabled, true);
  await h.input(TEST_IDS.order.limitPriceInput, '100');
  await h.press('order-ratio-100');
  await h.input(TEST_IDS.order.limitPriceInput, '50');
  assert.equal(h.node(qty).props.value, '0.5');
  assert.equal(h.node(slider).props.value, 50);
  assert.deepEqual(selected(h), []);
  await h.press('order-ratio-75');
  await h.press(TEST_IDS.order.typeToggleMarket);
  assert.deepEqual(selected(h), []);
  await h.press('order-ratio-75');
  for (const value of ['', 'abc', '0', '0.', '-1']) {
    await h.input(qty, value);
    assert.deepEqual(selected(h), []);
    assert.equal(h.node(slider).props.value, 0);
  }
  await h.press('order-ratio-50');
  await h.press(TEST_IDS.assetDetail.sellButton);
  assert.equal(h.node(qty).props.value, '');
  assert.equal(h.node(slider).props.value, 0);
  assert.deepEqual(selected(h), []);
  await h.press('order-ratio-50');
  h.positions.general = '8';
  await h.update();
  assert.equal(h.node(slider).props.value, 25);
  assert.deepEqual(selected(h), []);
  h.accountId = 'season';
  await h.update();
  assert.equal(h.node(qty).props.value, '');
  assert.equal(h.node(slider).props.value, 0);
  assert.deepEqual(selected(h), []);
});

for (const scenario of [
  'balance',
  'wallet-loading',
  'wallet-error',
  'price',
  'limit',
  'holding',
  'position-loading',
  'position-error',
  'unavailable',
  'inactive',
  'account',
])
  test(`${scenario}: slider blocks changes and preset retains the existing explanation`, async (t) => {
    const h = inlineTradingHarness();
    if (scenario === 'balance') {
      h.usdBalance = '1000';
      h.usdAvailable = '0';
    }
    if (scenario === 'wallet-loading') h.walletState = { isLoading: true };
    if (scenario === 'wallet-error') h.walletState = { isError: true };
    if (scenario === 'price') h.assets.bnb.price = { state: 'unavailable' };
    if (scenario === 'holding') h.positions.general = '0';
    if (scenario === 'position-loading') h.positionState = { isLoading: true };
    if (scenario === 'position-error') h.positionState = { isError: true };
    if (scenario === 'unavailable') h.positionDataState = 'unavailable';
    if (scenario === 'inactive') h.assets.bnb.isActive = false;
    if (scenario === 'account') h.accounts[0].status = 'suspended';
    await h.mount();
    t.after(h.close);
    if (
      ['holding', 'position-loading', 'position-error', 'unavailable'].includes(
        scenario,
      )
    )
      await h.press(TEST_IDS.assetDetail.sellButton);
    if (scenario === 'limit') await h.press(TEST_IDS.order.typeToggleLimit);
    assert.equal(h.node(slider).props.disabled, true);
    const reason = h.node(slider).props.title;
    assert.ok(reason);
    await h.slide(50);
    assert.equal(h.node(qty).props.value, '');
    await h.press('order-ratio-50');
    assert.ok(json(h).includes(reason));
    assert.deepEqual(selected(h), []);
    assert.equal(h.requests.length, 0);
  });

test('quote/create pending protects every quantity input, then success resets percentage', async (t) => {
  const h = inlineTradingHarness();
  h.quoteGate = deferred();
  h.createGate = deferred();
  await h.mount();
  t.after(h.close);
  await h.press('order-ratio-50');
  const value = h.node(qty).props.value;
  await h.press(TEST_IDS.order.executeSubmit);
  await h.flush();
  for (const phase of ['quote', 'create']) {
    assert.equal(h.node(qty).props.editable, false);
    assert.equal(h.node(slider).props.disabled, true);
    assert.equal(h.node('order-ratio-50').props.disabled, true);
    assert.equal(flatten(h.node('order-ratio-50').props.style).opacity, 0.4);
    await h.slide(75);
    await h.press('order-ratio-75');
    await h.input(qty, '123');
    assert.equal(h.node(qty).props.value, value);
    assert.deepEqual(selected(h), [50]);
    if (phase === 'quote') {
      h.quoteGate.resolve();
      await h.flush();
    }
  }
  h.createGate.resolve();
  await h.flush();
  assert.equal(h.node(qty).props.value, '');
  assert.equal(h.node(slider).props.value, 0);
  assert.deepEqual(selected(h), []);
  assert.equal(h.requests[0].body.quantity, value);
  assert.equal(h.requests[1].body.quantity, value);
  assert.ok(h.invalidations.length);
});

test('standalone account binding clears inputs when selection changes and cannot retarget an order', async (t) => {
  const h = inlineTradingHarness();
  h.Screen = h.OrderScreen;
  h.routeAccountId = 'general';
  await h.mount();
  t.after(h.close);
  await h.press('order-ratio-50');
  h.accountId = 'season';
  await h.update();
  assert.equal(h.node(slider), undefined);
  assert.match(json(h), /선택한 계정이 변경되었습니다/);
  h.accountId = 'general';
  await h.update();
  assert.equal(h.node(qty).props.value, '');
  assert.equal(h.node(slider).props.value, 0);
  assert.deepEqual(selected(h), []);
  assert.equal(h.requests.length, 0);
});
