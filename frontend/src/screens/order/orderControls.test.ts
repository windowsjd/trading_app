import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { financial } from '../../theme/financialColors.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness, act } = require('../../../test/inlineTradingHarness.cjs');
const { interactionHarness, flatten, React } = require('../../../test/interactionTestHarness.cjs');

const buy = TEST_IDS.assetDetail.buyButton;
const sell = TEST_IDS.assetDetail.sellButton;

function segmentHarness(initial: 'buy' | 'sell' = 'buy') {
  const h = interactionHarness('android');
  const Segment = h.load('src/screens/order/OrderSideSegment.tsx').default;
  const changes: string[] = [];
  let side = initial;
  const element = () => React.createElement(Segment, { side, onChange: (next: string) => changes.push(next) });
  const renderer = h.render(element());
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  return {
    h, changes, node,
    setSide: (next: 'buy' | 'sell') => { side = next; act(() => renderer.update(element())); },
    layout: (width: number) => act(() => node('order-side-segment').props.onLayout({ nativeEvent: { layout: { width } } })),
    thumb: () => renderer.root.findAll((n: any) => n.type === 'AnimatedView' && flatten(n.props.style).position === 'absolute' && flatten(n.props.style).width !== undefined)[0],
  };
}

describe('buy/sell segmented control', () => {
  it('shares one track and keeps the existing BUY/SELL colors on the moving thumb', () => {
    const s = segmentHarness();
    assert.equal(flatten(s.node('order-side-segment').props.style).backgroundColor !== undefined, true);
    // Before measurement the selected segment paints its own color.
    assert.equal(flatten(s.node(buy).props.style).backgroundColor, financial.buyAction);
    assert.equal(s.thumb() === undefined, true);
    s.layout(206);
    assert.equal(flatten(s.thumb().props.style).width, 100);
    assert.equal(flatten(s.node('order-side-thumb-buy').props.style).backgroundColor, financial.buyAction);
    assert.equal(flatten(s.node('order-side-thumb-sell').props.style).backgroundColor, financial.sellAction);
    assert.equal(flatten(s.node(buy).props.style).backgroundColor, undefined);
    assert.equal(flatten(s.node(buy).props.style).flex, 1);
    assert.equal(flatten(s.node(sell).props.style).flex, 1);
    assert.equal(flatten(s.node(buy).props.style).minHeight, 44);
    assert.equal(s.h.animations.length, 0, 'mount does not animate');
  });

  it('reports only a real change and leaves the selection to the caller', () => {
    const s = segmentHarness();
    act(() => s.node(buy).props.onPress());
    act(() => s.node(sell).props.onPress());
    assert.deepEqual(s.changes, ['sell']);
    assert.equal(s.node(buy).props.accessibilityState.selected, true);
    assert.equal(s.node('order-side-segment').props.accessibilityRole, 'tablist');
    assert.equal(s.node(sell).props.accessibilityRole, 'tab');
  });

  it('slides the thumb, and a quick second change continues from the current point to the final side', () => {
    const s = segmentHarness();
    s.layout(206);
    s.setSide('sell');
    s.setSide('buy');
    const [first, second] = s.h.animations;
    assert.deepEqual([first.options.toValue, second.options.toValue], [1, 0]);
    // The shared selection motion (reference video 2), same as every segmented control.
    assert.equal(first.options.duration, 140);
    assert.equal(first.options.useNativeDriver, true);
    assert.equal(first.value.animation === first, false, 'the first run was stopped');
    s.h.finish();
    assert.equal(second.value.value, 0);
    assert.equal(s.node(buy).props.accessibilityState.selected, true);
    assert.equal(s.node(sell).props.accessibilityState.selected, false);
  });

  it('Reduced Motion moves the thumb without an animation', () => {
    const s = segmentHarness();
    s.h.reduced = true;
    s.layout(206);
    s.setSide('sell');
    assert.equal(s.h.animations.length, 0);
    assert.equal(s.node(sell).props.accessibilityState.selected, true);
  });
});

describe('order panel side change', () => {
  it('remounts a clean form for the new side behind a short fade, without motion under Reduced Motion', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    await h.mount(); t.after(h.close);
    await h.selectOrderType('market');
    await h.input(TEST_IDS.order.quantityInput, '1');
    h.animations.length = 0;
    await h.press(sell);
    // The form fade starts in the press handler; the thumb follows the committed side.
    assert.deepEqual(h.animations.map((a: any) => [a.toValue, a.duration]), [[1, 180], [1, 140]]);
    // The new side starts with no method and no draft.
    assert.equal(h.freshForm(), true);
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.label, '매도');
    h.reduced = true;
    await h.update();
    await h.press(buy);
    assert.equal(h.animations.length, 2);
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.label, '매수');
    assert.equal(h.freshForm(), true);
  });
});

const methods = (h: any) => ['market', 'limit', 'conditional', 'loc', 'protection']
  .filter((method) => h.node(`order-method-${method}`) !== undefined);

describe('주문방식 field and sheet', () => {
  it('starts unselected: one full-width field, no inputs and no submit until a method is chosen', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    await h.mount(); t.after(h.close);
    const field = h.node(TEST_IDS.order.typeSelect);
    assert.equal(field.props.accessibilityRole, 'button');
    assert.ok(flatten(field.props.style).minHeight >= 44);
    assert.equal(h.orderType(), '주문방식 선택하기');
    assert.equal(h.node(TEST_IDS.order.quantityInput) === undefined, true);
    assert.equal(h.node(TEST_IDS.order.limitPriceInput) === undefined, true);
    assert.equal(h.node('order-ratio-50') === undefined, true);
    assert.equal(h.node('order-method-required') !== undefined, true);
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, 'disabled');
    await h.press(TEST_IDS.order.executeSubmit);
    assert.equal(h.requests.length, 0);
    // The old segmented 시장가/지정가 pair is gone.
    assert.equal(h.node(TEST_IDS.order.typeToggleMarket) === undefined, true);
    assert.equal(h.node(TEST_IDS.order.typeToggleLimit) === undefined, true);
  });

  it('crypto BUY lists 시장가, 지정가 and a server-gated 조건주문; never LOC', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    await h.mount(); t.after(h.close);
    await h.press(TEST_IDS.order.typeSelect);
    assert.equal(h.node(TEST_IDS.order.typeSelect).props.accessibilityState.expanded, true);
    assert.deepEqual(methods(h), ['market', 'limit', 'conditional']);
    // The server reports new Conditional BUY off: listed, not selectable.
    assert.equal(h.node('order-method-conditional').props.disabled, true);
    assert.equal(h.node('order-method-conditional-badge').props.children, '이용 불가');
    await h.press('order-method-conditional');
    assert.equal(h.orderType(), '주문방식 선택하기');
    await h.press('order-method-market');
    assert.equal(h.node('order-method-market') === undefined, true, 'a choice closes the sheet');
    assert.equal(h.orderType(), '시장가');
    await h.press(TEST_IDS.order.typeSelect);
    assert.equal(h.node('order-method-market').props.accessibilityState.selected, true);
    assert.equal(h.node('order-method-limit').props.accessibilityState.selected, false);
  });

  for (const [assetType, expected, ready] of [
    ['domestic_stock', ['market', 'limit', 'conditional', 'loc'], { conditional: '이용 불가', loc: '이용 불가' }],
    ['us_stock', ['market', 'limit', 'conditional', 'loc'], { conditional: '준비 중', loc: '준비 중' }],
  ] as const) {
    it(`${assetType} BUY lists four methods; new conditional/LOC follow the server or stay 준비 중`, async (t) => {
      const h = inlineTradingHarness();
      h.method = null;
      h.assetId = 'samsung';
      h.assets.samsung.assetType = assetType;
      await h.mount(); t.after(h.close);
      await h.press(TEST_IDS.order.typeSelect);
      assert.deepEqual(methods(h), expected);
      for (const [method, badge] of Object.entries(ready)) {
        assert.equal(h.node(`order-method-${method}`).props.disabled, true, method);
        assert.equal(h.node(`order-method-${method}-badge`).props.children, badge);
      }
    });
    it(`${assetType} SELL lists 시장가 and three server-gated methods (US 준비 중), never a new 지정가`, async (t) => {
      const h = inlineTradingHarness();
      h.method = null;
      h.assetId = 'samsung';
      h.assets.samsung.assetType = assetType;
      await h.mount(); t.after(h.close);
      await h.press(sell);
      await h.press(TEST_IDS.order.typeSelect);
      assert.deepEqual(methods(h), ['market', 'conditional', 'loc', 'protection']);
      // KRX follows the (default off) server gates; US waits for a data provider.
      for (const method of ['conditional', 'loc', 'protection']) {
        assert.equal(h.node(`order-method-${method}`).props.disabled, true, method);
        assert.equal(h.node(`order-method-${method}-badge`).props.children, assetType === 'us_stock' ? '준비 중' : '이용 불가');
      }
    });
  }

  it('the backdrop, the close button and Android back close the sheet without choosing', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    await h.mount(); t.after(h.close);
    for (const close of ['order-method-sheet-backdrop', 'order-method-sheet-close', 'back']) {
      await h.press(TEST_IDS.order.typeSelect);
      assert.equal(h.node('order-method-sheet') !== undefined, true);
      if (close === 'back') {
        let handled = false;
        await act(async () => { handled = h.backHandler(); });
        assert.equal(handled, true);
      } else await h.press(close);
      assert.equal(h.node('order-method-sheet') === undefined, true, close);
      assert.equal(h.orderType(), '주문방식 선택하기');
    }
  });

  it('a method change clears the draft and quote; re-choosing the same method keeps them', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.input(TEST_IDS.order.quantityInput, '3');
    await h.selectOrderType('market');
    assert.equal(h.node(TEST_IDS.order.quantityInput).props.value, '3', 're-choosing the same method keeps inputs');
    await h.selectOrderType('limit');
    assert.equal(h.orderType(), '지정가');
    assert.equal(h.node(TEST_IDS.order.quantityInput).props.value, '');
    await h.input(TEST_IDS.order.limitPriceInput, '700');
    await h.input(TEST_IDS.order.quantityInput, '2');
    await h.selectOrderType('market');
    assert.equal(h.node(TEST_IDS.order.limitPriceInput) === undefined, true);
    assert.equal(h.node(TEST_IDS.order.quantityInput).props.value, '');
    await h.selectOrderType('limit');
    assert.equal(h.node(TEST_IDS.order.limitPriceInput).props.value, '', 'market cleared the limit price');
  });

  it('the sheet rises and falls with the shared sheet motion, and opens without motion under Reduced Motion', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    await h.mount(); t.after(h.close);
    h.animations.length = 0;
    await h.press(TEST_IDS.order.typeSelect);
    await h.press('order-method-market');
    assert.deepEqual(h.animations.map((a: any) => [a.toValue, a.duration]), [[1, 280], [0, 220]]);
    h.reduced = true;
    await h.update();
    h.animations.length = 0;
    await h.press(TEST_IDS.order.typeSelect);
    assert.equal(h.node('order-method-sheet') !== undefined, true);
    await h.press('order-method-limit');
    assert.equal(h.animations.length, 0);
    assert.equal(h.orderType(), '지정가');
  });
});
