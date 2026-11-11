import Decimal from 'decimal.js';
import assert from 'node:assert/strict';
import { semantic } from '../../theme/tokens.ts';
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
        // A new sell limit is not offered (orderInputPolicy covers that).
        if (!(side === 'sell' && type === 'limit')) test(`${screen} ${account} ${side} ${type}: presets and slider share quantity policy and selection`, async (t) => {
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
            await h.selectOrderType('limit');
            await h.input(TEST_IDS.order.limitPriceInput, '50');
          }
          // Crypto SELL is entered by amount (2026-11-10): 100% is the holding
          // at the shown price (100), and a ratio is its exact share of the
          // holding (six decimals, floored) shown as that share's estimate.
          const capacity =
            side === 'buy'
              ? 100.2 / 1.001
              : Number(h.positions[account]) * 100;
          const sellQuantityAt = (percent: number) =>
            new Decimal(h.positions[account]).mul(percent / 100).toDecimalPlaces(6, Decimal.ROUND_DOWN);
          const valueAt = (percent: number) => side === 'buy'
            ? new Decimal('100.2').mul(percent / 100).div('1.001').toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(8)
            : sellQuantityAt(percent).mul('100').toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2);
          for (const percent of [25, 50, 75, 100]) {
            await h.press(`order-ratio-${percent}`);
            const expected = valueAt(percent);
            assert.equal(h.node(qty).props.value, expected);
            if (side === 'sell')
              assert.match(json(h), new RegExp(`매도 수량 ${sellQuantityAt(percent).toFixed().replace('.', '\\.')} BNB`));
            assert.equal(h.node(slider).props.value, percent);
            assert.deepEqual(selected(h), [percent]);
            for (const other of [25, 50, 75, 100]) {
              const button = h.node(`order-ratio-${other}`);
              assert.equal(
                flatten(button.props.style).backgroundColor,
                other === percent ? semantic.selected : semantic.raised,
              );
              const label = button.findByType('Text');
              assert.equal(
                flatten(label.props.style).color,
                other === percent ? semantic.onAccent : semantic.text,
              );
            }
            await h.slide(percent);
            assert.equal(h.node(qty).props.value, expected);
          }
          await h.slide(37);
          assert.equal(h.node(qty).props.value, valueAt(37));
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
            /0보다 큰 수량|0보다 큰 숫자|수량을 입력해주세요|계산된 수량이 너무 작습니다|계산된 매(수|도) 금액이 너무 작습니다/,
          );
          await h.slide(-10);
          assert.equal(h.node(qty).props.value, '');
          await h.slide(110);
          assert.equal(h.node(qty).props.value, valueAt(100));
          await h.slide(NaN);
          assert.equal(h.node(qty).props.value, valueAt(100));
          assert.equal(h.requests.length, 0);
        });

test('six-decimal flooring preserves the selected ratio; rejected tiny quantity does not move the controls', async (t) => {
  const h = inlineTradingHarness();
  h.positions.general = '0.000007';
  // Crypto SELL is entered by amount: at this price the 0.000007 holding is
  // worth $7.00, so every step below stays above a cent.
  h.assets.bnb.price.currentPrice = '1000000';
  await h.mount();
  t.after(h.close);
  await h.press(TEST_IDS.assetDetail.sellButton);
  await h.press('order-ratio-50');
  // 50% floors to 0.000003 (not 0.0000035): its $3.00, still selected as 50%.
  assert.equal(h.node(qty).props.value, '3.00');
  assert.match(json(h), /매도 수량 0\.000003 BNB/);
  assert.equal(h.node(slider).props.value, 50);
  await h.slide(1);
  assert.equal(h.node(qty).props.value, '3.00');
  assert.deepEqual(selected(h), [50]);
  assert.match(json(h), /계산된 매도 금액이 너무 작습니다/);
  await h.input(qty, '3');
  assert.equal(h.node(slider).props.value, 43);
  assert.deepEqual(selected(h), []);
  await h.slide(0);
  assert.doesNotMatch(json(h), /계산된 매도 금액이 너무 작습니다/);
  // The preset sends its exact floored quantity, not an amount.
  await h.press('order-ratio-50');
  await h.press(TEST_IDS.order.executeSubmit);
  await h.flush();
  assert.equal(h.requests[0].body.quantity, '0.000003');
  assert.equal(h.requests[0].body.amount === undefined, true);
});

test('crypto SELL by amount: a ratio keeps its exact quantity; the price moves only its estimate; a holding or reservation change drops the selection', async (t) => {
  const h = inlineTradingHarness();
  h.assets.bnb.price.currentPrice = '100';
  await h.mount();
  t.after(h.close);
  await h.press(TEST_IDS.assetDetail.sellButton);
  await h.press('order-ratio-50');
  assert.equal(h.node(qty).props.value, '200.00');
  // A price move re-estimates the same 2 BNB; the selection stays.
  h.assets.bnb = { ...h.assets.bnb, price: { ...h.assets.bnb.price, currentPrice: '200' } };
  await h.update();
  assert.equal(h.node(qty).props.value, '400.00');
  assert.match(json(h), /매도 수량 2 BNB/);
  assert.deepEqual(selected(h), [50]);
  assert.equal(h.node(slider).props.value, 50);
  // A larger holding: 2 BNB is no longer 50%; it is still what would be sold.
  h.positions.general = '8';
  await h.update();
  assert.deepEqual(selected(h), []);
  assert.equal(h.node(slider).props.value, 25);
  assert.match(json(h), /매도 수량 2 BNB/);
  // Other orders reserve 7 of the 8: the re-picked 4 BNB is no longer 50% of
  // what is sellable (1) and does not fit; the form says so, never sells less.
  await h.press('order-ratio-50');
  assert.match(json(h), /매도 수량 4 BNB/);
  h.positionAvailable = { general: '1' };
  h.positionReserved = { general: '7' };
  await h.update();
  assert.deepEqual(selected(h), []);
  assert.match(json(h), /매도 가능 금액을 초과했습니다/);
  assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, 'disabled');
  // Typing replaces the ratio: the amount is sent as typed, never a quantity.
  await h.input(qty, '150');
  assert.match(json(h), /예상 매도 수량 약 0\.75 BNB/);
  await h.press(TEST_IDS.order.executeSubmit);
  await h.flush();
  assert.equal(h.requests[0].body.amount, '150');
  assert.equal(h.requests[0].body.quantity === undefined, true);
});

test('manual edits, price, reservations, limit changes and side/account changes never retain stale selection', async (t) => {
  const h = inlineTradingHarness();
  h.assets.bnb.assetType = 'us_stock';
  h.usdBalance = '1002';
  h.usdReserved = '0';
  h.usdAvailable = '1002';
  h.assets.bnb.price.currentPrice = '100';
  await h.mount();
  t.after(h.close);
  await h.press('order-ratio-50');
  h.assets.bnb = {
    ...h.assets.bnb,
    price: { ...h.assets.bnb.price, currentPrice: '200' },
  };
  await h.update();
  assert.equal(h.node(qty).props.value, '5');
  assert.equal(h.node(slider).props.value, 100);
  assert.deepEqual(selected(h), []);
  await h.press('order-ratio-50');
  h.usdReserved = '501';
  h.usdAvailable = '501';
  await h.update();
  assert.equal(h.node(qty).props.value, '2.5');
  assert.equal(h.node(slider).props.value, 100);
  assert.deepEqual(selected(h), []);
  await h.selectOrderType('limit');
  assert.equal(h.node(slider).props.disabled, true);
  await h.input(TEST_IDS.order.limitPriceInput, '100');
  await h.press('order-ratio-100');
  await h.input(TEST_IDS.order.limitPriceInput, '50');
  assert.equal(h.node(qty).props.value, '5');
  assert.equal(h.node(slider).props.value, 50);
  assert.deepEqual(selected(h), []);
  await h.press('order-ratio-75');
  await h.selectOrderType('market');
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
  h.routeAccountId = 'season';
  await h.update();
  // Another account's form starts at 시장가 with no draft and no ratio.
  assert.equal(h.freshForm(), true);
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
    if (scenario === 'price' || scenario === 'limit') h.assets.bnb.assetType = 'us_stock';
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
    if (scenario === 'limit') await h.selectOrderType('limit');
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
  assert.equal(h.requests[0].body.amount, value);
  assert.equal(h.requests[1].body.amount, value);
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
  assert.equal(h.node(slider) === undefined, true);
  assert.match(json(h), /선택한 계정이 변경되었습니다/);
  h.accountId = 'general';
  await h.update();
  // Back on the route account: the abandoned draft and ratio are gone; 시장가 again.
  assert.equal(h.freshForm(), true);
  assert.equal(h.node(slider).props.value, 0);
  assert.deepEqual(selected(h), []);
  assert.equal(h.requests.length, 0);
});

// A stock 지정가/LOC BUY takes whole shares, and the ratio keeps its fee
// buffer (never below 0.2%), so a ratio can floor to 0 shares. Which message
// follows (2026-11-07) is the live balance check for ONE share at the entered
// price and the account's own fee: "cannot buy one share" only when it really
// does not fit; otherwise it is the ratio that could not reach a share; with
// no usable fee it claims neither. The ratio quantities never change.
const WHOLE_SHARE = '지정가 주문은 1주 단위로 가능해요. 현재 주문 가능 금액으로는 1주를 매수할 수 없어요.';
const RATIO_SHARE = '선택한 비율로는 1주를 계산할 수 없어요. 주식 지정가 주문은 1주 단위예요.';
const RATIO_UNKNOWN = `${RATIO_SHARE} 수량을 직접 입력해 확인해 주세요.`;
const TOO_SMALL = '계산된 수량이 너무 작습니다.';
const RATIO_MESSAGES = [WHOLE_SHARE, RATIO_SHARE, RATIO_UNKNOWN, TOO_SMALL];
const shows = (h: any, message: string) => json(h).includes(message);
/** The ratio message on screen as one exact string (RATIO_UNKNOWN extends RATIO_SHARE), or null. */
const ratioMessage = (h: any): string | null =>
  h.renderer.root.findAll((n: any) => typeof n.type === 'string' && RATIO_MESSAGES.includes(n.props.children))[0]?.props.children ?? null;
/** The live balance check's line (the fee-included total above the available cash), or null. */
const shortage = (h: any): string | null => h.node('order-balance-insufficient')?.props.children ?? null;
function usStock(h: any, available: string) {
  h.assets.bnb.assetType = 'us_stock';
  h.usdBalance = available;
  h.usdReserved = '0';
  h.usdAvailable = available;
}
function krStock(h: any, balance: string) {
  h.assetId = 'samsung';
  h.assets.samsung.marketStatus = 'open';
  h.assets.samsung.tradable = true;
  h.krwBalance = balance;
}
type StockBuy = { name: string; market: 'us' | 'kr'; method: 'limit' | 'loc' };
const STOCK_BUYS: StockBuy[] = [
  { name: 'US limit', market: 'us', method: 'limit' },
  { name: 'US LOC', market: 'us', method: 'loc' },
  { name: 'KR limit', market: 'kr', method: 'limit' },
  { name: 'KR LOC', market: 'kr', method: 'loc' },
];
// Per market: a limit price; cash under one share; a price that cash buys
// whole shares at; and the cash that pays exactly one share at the price with
// the default 0.1% fee (182 + 0.182 · 182,000 + 182), and 1e-8 less.
const AT = {
  us: { price: '182', short: '25.87', reachable: '12', shares: '2', exact: '182.182', belowExact: '182.18199999' },
  kr: { price: '182000', short: '150000', reachable: '12000', shares: '12', exact: '182182', belowExact: '182181.99999999' },
};
function stockBuy(h: any, scenario: StockBuy, available: string) {
  if (scenario.market === 'us') usStock(h, available);
  else krStock(h, available);
  if (scenario.method === 'loc')
    h.orderCapabilities = { tradingAccountId: 'general', limitOrder: { enabled: true, autoExecutionEnabled: false },
      limitOnClose: { enabled: true, markets: [scenario.market === 'us' ? 'US' : 'KRX'], sides: ['buy'], attachedProtection: false } };
}

for (const scenario of STOCK_BUYS)
  test(`${scenario.name} BUY: an amount below one share at the entered price explains the whole-share rule`, async (t) => {
    const at = AT[scenario.market];
    const h = inlineTradingHarness();
    stockBuy(h, scenario, at.short);
    await h.mount();
    t.after(h.close);
    await h.selectOrderType(scenario.method);
    await h.input(TEST_IDS.order.limitPriceInput, at.price);
    assert.equal(ratioMessage(h), null, 'no explanation before a ratio is used');
    for (const percent of [25, 50, 75, 100]) {
      await h.press(`order-ratio-${percent}`);
      assert.equal(ratioMessage(h), WHOLE_SHARE, `${percent}%`);
      assert.equal(h.node(qty).props.value, '');
      assert.deepEqual(selected(h), []);
    }
    // The live balance check agrees: one share typed is short as well.
    await h.input(qty, '1');
    assert.equal(shortage(h), '잔액이 부족합니다.');
    await h.slide(0);
    assert.equal(h.node(qty).props.value, '');
    assert.equal(ratioMessage(h), null, '0% clears the input and says nothing');
    await h.slide(60);
    assert.equal(ratioMessage(h), WHOLE_SHARE, 'the slider explains too');
    // A price one share fits under: whole shares again, and the explanation is gone.
    await h.input(TEST_IDS.order.limitPriceInput, at.reachable);
    assert.equal(ratioMessage(h), null, 'a price change clears it');
    await h.press('order-ratio-100');
    assert.equal(h.node(qty).props.value, at.shares);
    assert.equal(ratioMessage(h), null);
    assert.equal(h.requests.length, 0);
  });

// The reported defect: the real fee (0.1%) fits one share while the ratio's
// 0.2% buffer floors 100% to 0 shares.
for (const scenario of STOCK_BUYS)
  for (const fits of [true, false])
    test(`${scenario.name} BUY: cash ${fits ? 'exactly at' : '1e-8 under'} one share with the real fee follows the balance check, not the ratio buffer`, async (t) => {
      const at = AT[scenario.market];
      const h = inlineTradingHarness();
      stockBuy(h, scenario, fits ? at.exact : at.belowExact);
      await h.mount();
      t.after(h.close);
      await h.selectOrderType(scenario.method);
      await h.input(TEST_IDS.order.limitPriceInput, at.price);
      for (const percent of [25, 50, 75, 100]) {
        await h.press(`order-ratio-${percent}`);
        // The ratio itself is unchanged: its buffer still floors to 0 shares.
        assert.equal(h.node(qty).props.value, '', `${percent}%`);
        assert.deepEqual(selected(h), []);
        assert.equal(ratioMessage(h), fits ? RATIO_SHARE : WHOLE_SHARE, `${percent}%`);
      }
      await h.input(TEST_IDS.order.limitPriceInput, at.reachable);
      assert.equal(ratioMessage(h), null, 'a price change clears it');
      // One share typed at the same price: the live check says the same thing.
      await h.input(TEST_IDS.order.limitPriceInput, at.price);
      await h.input(qty, '1');
      assert.equal(shortage(h), fits ? null : '잔액이 부족합니다.');
      assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, fits ? 'enabled' : 'disabled');
      await h.slide(0);
      assert.equal(h.node(qty).props.value, '');
      assert.equal(ratioMessage(h), null, '0% says nothing');
      assert.equal(h.requests.length, 0);
    });

test('stock limit BUY: a ratio under one share of an amount that buys one says the ratio could not reach a share', async (t) => {
  const h = inlineTradingHarness();
  usStock(h, '300');
  await h.mount();
  t.after(h.close);
  await h.selectOrderType('limit');
  await h.input(TEST_IDS.order.limitPriceInput, '182');
  for (const percent of [25, 50]) {
    await h.press(`order-ratio-${percent}`);
    assert.equal(ratioMessage(h), RATIO_SHARE, `${percent}%`);
    assert.equal(h.node(qty).props.value, '');
  }
  for (const percent of [75, 100]) {
    await h.press(`order-ratio-${percent}`);
    assert.equal(h.node(qty).props.value, '1', `${percent}%`);
    assert.equal(ratioMessage(h), null);
  }
});

// The same cash and price under each account's own fee (general 0.1% by
// default; a season sets its own): the ratio keeps max(0.2%, fee) either way.
for (const [account, feeRate, expected] of [
  ['general', '0.001000', RATIO_SHARE], // 182.182 fits 182.3
  ['season', '0.003000', WHOLE_SHARE], // 182.546 does not
  ['season', '0.000000', RATIO_SHARE], // 182 fits
] as const)
  test(`${account} account at a ${feeRate} fee: one share is judged at that account's own fee`, async (t) => {
    const h = inlineTradingHarness();
    h.accountId = account;
    h.feeRate = feeRate;
    usStock(h, '182.3');
    await h.mount();
    t.after(h.close);
    await h.selectOrderType('limit');
    await h.input(TEST_IDS.order.limitPriceInput, '182');
    await h.press('order-ratio-100');
    assert.equal(h.node(qty).props.value, '');
    assert.equal(ratioMessage(h), expected);
    await h.input(qty, '1');
    assert.equal(shortage(h), expected === WHOLE_SHARE ? '잔액이 부족합니다.' : null, 'the live check agrees');
  });

// No usable fee (read pending or failed, or an unreadable value): the ratio
// still floors with its buffer, and the message claims neither way — for
// cash far below one share and for cash that pays one exactly.
for (const fee of ['loading', 'failed', 'invalid'] as const)
  for (const available of ['25.87', '182.182'])
    test(`stock limit BUY with the fee ${fee} and ${available} USD: a 0-share ratio asks for a typed quantity`, async (t) => {
      const h = inlineTradingHarness();
      usStock(h, available);
      if (fee === 'loading') h.accountDetailState = { isLoading: true, isPending: true, data: undefined };
      if (fee === 'failed') h.accountDetailState = { isError: true, error: new Error('offline'), data: undefined };
      if (fee === 'invalid') h.feeRate = 'invalid';
      await h.mount();
      t.after(h.close);
      await h.selectOrderType('limit');
      await h.input(TEST_IDS.order.limitPriceInput, '182');
      await h.press('order-ratio-100');
      assert.equal(h.node(qty).props.value, '');
      assert.equal(ratioMessage(h), RATIO_UNKNOWN);
      // The live check never claims a shortage on an unknown fee either; the server's quote decides.
      await h.input(qty, '1');
      assert.equal(shortage(h), null);
      assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, 'enabled');
      assert.equal(h.requests.length, 0);
    });

test('stock market BUY keeps fractional ratio quantities for the same amount and price', async (t) => {
  const h = inlineTradingHarness();
  usStock(h, '25.87');
  h.assets.bnb.price.currentPrice = '182';
  await h.mount();
  t.after(h.close);
  await h.press('order-ratio-100');
  // 25.87 / (182 × 1.002), floored to six decimals.
  assert.equal(h.node(qty).props.value, '0.141859');
  assert.equal(ratioMessage(h), null);
});

test('crypto BUY keeps its amount message at market and limit, never the stock whole-share copy', async (t) => {
  const h = inlineTradingHarness();
  h.usdBalance = '0.00000002';
  h.usdReserved = '0';
  h.usdAvailable = '0.00000002';
  await h.mount();
  t.after(h.close);
  for (const method of ['market', 'limit']) {
    if (method === 'limit') {
      await h.selectOrderType('limit');
      await h.input(TEST_IDS.order.limitPriceInput, '763');
    }
    await h.press('order-ratio-25');
    assert.equal(shows(h, '계산된 매수 금액이 너무 작습니다.'), true, method);
    assert.equal(ratioMessage(h), null, method);
    // 100% of the cash net of the real fee, floored to eight decimals.
    await h.press('order-ratio-100');
    assert.equal(h.node(qty).props.value, '0.00000001', method);
  }
  assert.equal(h.requests.length, 0);
});
