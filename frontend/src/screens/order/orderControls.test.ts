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
    assert.equal(first.options.duration, 200);
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
    assert.deepEqual(h.animations.map((a: any) => [a.toValue, a.duration]), [[1, 180], [1, 200]]);
    assert.equal(h.node(TEST_IDS.order.quantityInput).props.value, '');
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.label, '매도');
    h.reduced = true;
    await h.update();
    await h.press(buy);
    assert.equal(h.animations.length, 2);
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.label, '매수');
  });
});

describe('market/limit dropdown', () => {
  it('is one full-width button, about 2/3 of the former 44px tabs, keeping a 44px target', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    const trigger = h.node(TEST_IDS.order.typeSelect);
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node(TEST_IDS.order.typeToggleMarket) === undefined, true, 'no tab pair remains');
    const style = flatten(trigger.props.style);
    assert.equal(style.alignSelf, 'stretch');
    const surface = trigger.findAll((n: any) => n.type === 'View' && flatten(n.props.style).minHeight !== undefined)[0];
    const visual = flatten(surface.props.style).minHeight;
    assert.equal(visual, 30);
    assert.ok(Math.abs(visual / 44 - 2 / 3) < 0.03);
    assert.equal(visual + style.paddingVertical * 2, 44);
    assert.equal(style.marginVertical, -style.paddingVertical, 'the touch band does not add layout height');
    assert.equal(h.node('order-type-select-triangle') !== undefined, true);
    assert.equal(trigger.props.accessibilityRole, 'button');
    assert.equal(trigger.props.accessibilityState.expanded, false);
  });

  it('opens from anywhere on the button, marks the current type and switches the form', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.press(TEST_IDS.order.typeSelect);
    assert.equal(h.node(TEST_IDS.order.typeSelect).props.accessibilityState.expanded, true);
    assert.equal(h.node(TEST_IDS.order.typeToggleMarket).props.accessibilityState.selected, true);
    assert.equal(h.node(TEST_IDS.order.typeToggleLimit).props.accessibilityState.selected, false);
    assert.equal(h.node(TEST_IDS.order.typeToggleLimit).props.accessibilityRole, 'menuitem');
    await h.press(TEST_IDS.order.typeToggleLimit);
    assert.equal(h.node('order-type-menu') === undefined, true);
    assert.equal(h.orderType(), '지정가');
    assert.equal(h.node(TEST_IDS.order.limitPriceInput) !== undefined, true);
    await h.input(TEST_IDS.order.limitPriceInput, '700');
    await h.selectOrderType('market');
    assert.equal(h.node(TEST_IDS.order.limitPriceInput) === undefined, true);
    await h.selectOrderType('limit');
    assert.equal(h.node(TEST_IDS.order.limitPriceInput).props.value, '', 'market cleared the limit price');
  });

  it('closes on the backdrop and Android back without changing the type or inputs', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.input(TEST_IDS.order.quantityInput, '3');
    await h.press(TEST_IDS.order.typeSelect);
    await h.press('order-type-menu-backdrop');
    assert.equal(h.node('order-type-menu') === undefined, true);
    await h.press(TEST_IDS.order.typeSelect);
    const modal = h.renderer.root.findAll((n: any) => n.type === 'Modal')[0];
    assert.equal(modal.props.transparent, true);
    assert.equal(modal.props.animationType, 'fade');
    await act(async () => modal.props.onRequestClose());
    assert.equal(h.node('order-type-menu') === undefined, true);
    await h.press(TEST_IDS.order.typeSelect);
    await h.press(TEST_IDS.order.typeToggleMarket);
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node(TEST_IDS.order.quantityInput).props.value, '3', 're-selecting the current type keeps inputs');
    h.reduced = true;
    await h.update();
    await h.press(TEST_IDS.order.typeSelect);
    assert.equal(h.renderer.root.findAll((n: any) => n.type === 'Modal')[0].props.animationType, 'none');
  });

  it('places the menu under the button, flips near the bottom and stays inside narrow screens', () => {
    const h = interactionHarness('android');
    const { placeOrderTypeMenu } = h.load('src/screens/order/OrderTypeSelect.tsx');
    const frame = { x: 0, y: 0, width: 320, height: 640 };
    // Same window coordinates for the trigger and the modal root.
    assert.deepEqual(placeOrderTypeMenu({ x: 12, y: 200, width: 150, height: 30 }, frame, 96), { left: 12, top: 234, width: 150 });
    assert.deepEqual(placeOrderTypeMenu({ x: 12, y: 580, width: 150, height: 30 }, frame, 96), { left: 12, top: 480, width: 150 });
    assert.deepEqual(placeOrderTypeMenu({ x: 250, y: 200, width: 60, height: 30 }, frame, 96), { left: 172, top: 234, width: 140 });
    // A modal window that starts below the status bar shifts both rects alike.
    assert.deepEqual(placeOrderTypeMenu({ x: 12, y: 200, width: 150, height: 30 }, { ...frame, y: 24 }, 96), { left: 12, top: 210, width: 150 });
  });
});
