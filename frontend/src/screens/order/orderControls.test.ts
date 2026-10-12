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
    await h.mount(); t.after(h.close);
    await h.input(TEST_IDS.order.quantityInput, '1');
    assert.equal(h.animations.length, 0);
    await h.press(sell);
    // The form fade starts in the press handler; the thumb follows the committed side.
    assert.deepEqual(h.animations.map((a: any) => [a.toValue, a.duration]), [[1, 180], [1, 140]]);
    assert.equal(h.node(TEST_IDS.order.quantityInput).props.value, '');
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.label, '매도');
    h.reduced = true;
    await h.update();
    await h.press(buy);
    assert.equal(h.animations.length, 2);
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.label, '매수');
  });
});

describe('market/limit segmented selector', () => {
  it('is one track of two tab segments keeping a 44dp target', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node(TEST_IDS.order.typeSelect).props.accessibilityRole, 'tablist');
    const market = h.node(TEST_IDS.order.typeToggleMarket);
    const limit = h.node(TEST_IDS.order.typeToggleLimit);
    for (const segment of [market, limit]) {
      assert.equal(segment.props.accessibilityRole, 'tab');
      const style = flatten(segment.props.style);
      assert.ok(style.minHeight + segment.props.hitSlop.top + segment.props.hitSlop.bottom >= 44);
    }
    assert.deepEqual([market.props.accessibilityState.selected, limit.props.accessibilityState.selected], [true, false]);
    assert.equal(h.node('order-type-menu') === undefined, true, 'no dropdown menu remains');
  });

  it('switches the form on press and clears the limit price when leaving 지정가', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.selectOrderType('limit');
    assert.equal(h.orderType(), '지정가');
    assert.equal(h.node(TEST_IDS.order.limitPriceInput) !== undefined, true);
    await h.input(TEST_IDS.order.limitPriceInput, '700');
    await h.selectOrderType('market');
    assert.equal(h.node(TEST_IDS.order.limitPriceInput) === undefined, true);
    await h.selectOrderType('limit');
    assert.equal(h.node(TEST_IDS.order.limitPriceInput).props.value, '', 'market cleared the limit price');
  });

  it('re-selecting the current type keeps inputs; Reduced Motion moves without animation', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.input(TEST_IDS.order.quantityInput, '3');
    await h.selectOrderType('market');
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node(TEST_IDS.order.quantityInput).props.value, '3', 're-selecting the current type keeps inputs');
    h.reduced = true;
    await h.update();
    const before = h.animations.length;
    await h.selectOrderType('limit');
    assert.equal(h.orderType(), '지정가');
    assert.equal(h.animations.filter((a: any) => a.duration === 140).length, h.animations.slice(0, before).filter((a: any) => a.duration === 140).length);
  });
});
