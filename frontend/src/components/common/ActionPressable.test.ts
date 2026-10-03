import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const event = { nativeEvent: { pageX: 130, pageY: 215 } };
const wash = (renderer: any) => renderer.root.findAllByType('View').find((n: any) => n.props.pointerEvents === 'none');

describe('ActionPressable immediate feedback', () => {
  for (const platform of ['android', 'ios', 'web']) {
    it(`${platform}: one static wash, immediate single action and no release work`, (t) => {
      const h = interactionHarness(platform);
      h.delayedMeasure = true;
      const calls: unknown[] = [];
      const ref = { current: null };
      const style = { backgroundColor: '#111', borderRadius: 12, padding: 14, elevation: 3, transform: [{ translateX: 4 }] };
      const onPress = (e: unknown) => calls.push(e);
      const renderer = h.render(React.createElement(h.ActionPressable, {
        ref, testID: 'action', style, onPress, hitSlop: 8, accessibilityLabel: '주문',
        onPressIn: () => calls.push('in'), onPressOut: () => calls.push('out'), onLongPress: () => calls.push('long'),
      }, ({ pressed }: { pressed: boolean }) => React.createElement('Text', null, pressed ? 'pressed' : 'idle')));
      t.after(() => act(() => renderer.unmount()));
      const button = () => renderer.root.findByType('Pressable');
      assert.ok(ref.current);
      assert.strictEqual(button().props.onPress, onPress);
      assert.deepEqual(flatten(button().props.style), style);
      assert.equal(button().props.hitSlop, 8);
      assert.equal(button().props.accessibilityLabel, '주문');
      assert.equal(flatten(wash(renderer).props.style).opacity, 0);
      act(() => button().props.onPressIn(event));
      const overlay = wash(renderer);
      assert.equal(flatten(overlay.props.style).opacity, 0.045);
      assert.equal(flatten(overlay.props.style).backgroundColor, '#fff');
      assert.equal(flatten(overlay.props.style).borderRadius, 12);
      assert.equal(flatten(overlay.props.style).overflow, 'hidden');
      assert.equal(overlay.props.accessibilityElementsHidden, true);
      assert.equal(overlay.props.importantForAccessibility, 'no-hide-descendants');
      assert.deepEqual(flatten(button().props.style), style, 'content geometry, opacity and shadow stay intact');
      assert.equal(renderer.root.findByType('Text').props.children, 'pressed');
      button().props.onPress(event);
      act(() => button().props.onPressOut(event));
      button().props.onLongPress(event);
      assert.deepEqual(calls, ['in', event, 'out', 'long']);
      assert.equal(flatten(wash(renderer).props.style).opacity, 0);
      assert.equal(renderer.root.findByType('Text').props.children, 'idle');
      assert.equal(h.measures.length, 0, 'feedback never waits for measurement');
      assert.equal(h.animations.length, 0, 'no moving feedback even before Reduced Motion preference resolves');
    });
  }

  it('resolves style callbacks and preserves string transforms and functional children', (t) => {
    const h = interactionHarness('web');
    const renderer = h.render(React.createElement(h.ActionPressable, {
      onPress() {}, style: ({ pressed }: { pressed: boolean }) => ({ backgroundColor: pressed ? '#fff' : '#111', transform: 'translateX(4px)', borderTopLeftRadius: 9 }),
    }, ({ pressed }: { pressed: boolean }) => React.createElement('Text', null, String(pressed))));
    t.after(() => act(() => renderer.unmount()));
    act(() => renderer.root.findByType('Pressable').props.onPressIn(event));
    assert.equal(flatten(wash(renderer).props.style).backgroundColor, '#000');
    assert.equal(flatten(wash(renderer).props.style).borderTopLeftRadius, 9);
    assert.equal(flatten(renderer.root.findByType('Pressable').props.style).transform, 'translateX(4px)');
    assert.equal(renderer.root.findByType('Text').props.children, 'true');
  });

  it('CTA disabled/loading/blocked keeps actions disabled and removes feedback', (t) => {
    const h = interactionHarness();
    const CTA = h.load('src/components/common/CTAButton.tsx', { './ActionPressable': { default: h.ActionPressable, __esModule: true } }).default;
    const onPress = () => {};
    const renderer = h.render(React.createElement(CTA, { label: '환전하기', onPress, style: { backgroundColor: '#111' } }));
    t.after(() => act(() => renderer.unmount()));
    assert.equal(renderer.root.findByType('Text').props.numberOfLines, undefined);
    act(() => renderer.root.findByType('Pressable').props.onPressIn(event));
    assert.equal(flatten(wash(renderer).props.style).opacity, 0.045);
    for (const state of ['disabled', 'loading', 'blocked']) {
      act(() => renderer.update(React.createElement(CTA, { label: '환전하기', state, onPress })));
      const button = renderer.root.findByType('Pressable');
      assert.equal(button.props.disabled, true);
      assert.equal(button.props.onPress, undefined);
      assert.equal(wash(renderer), undefined);
      assert.equal(renderer.root.findAllByType('ActivityIndicator').length, state === 'loading' ? 1 : 0);
      assert.equal(button.props.accessibilityState.busy, state === 'loading');
    }
    for (const props of [{}, { onPress, 'aria-disabled': true }, { onPress, accessibilityState: { disabled: true } }]) {
      act(() => renderer.update(React.createElement(h.ActionPressable, props)));
      assert.equal(wash(renderer), undefined);
    }
    assert.equal(h.animations.length, 0);
  });

  it('release/cancel, rapid taps, keyboard input and unmount leave no pending feedback', (t) => {
    const h = interactionHarness();
    let calls = 0;
    const renderer = h.render(React.createElement(h.ActionPressable, { onPress: () => calls++ }));
    t.after(() => act(() => renderer.unmount()));
    const button = () => renderer.root.findByType('Pressable');
    for (let tap = 0; tap < 5; tap++) {
      act(() => button().props.onPressIn({ nativeEvent: {} }));
      assert.equal(flatten(wash(renderer).props.style).opacity, 0.05);
      act(() => button().props.onPressOut(event));
      assert.equal(flatten(wash(renderer).props.style).opacity, 0);
    }
    assert.equal(calls, 0, 'scroll cancellation does not invoke the action');
    act(() => button().props.onPress());
    assert.equal(calls, 1);
    assert.equal(h.animations.length, 0);
    assert.equal(h.measures.length, 0);
  });

  it('Market sort directions explicitly opt out without altering their actions', (t) => {
    const h = interactionHarness();
    let calls = 0;
    const renderer = h.render(React.createElement(h.ActionPressable, { feedback: 'none', onPress: () => calls++, style: { padding: 2 } }));
    t.after(() => act(() => renderer.unmount()));
    const button = renderer.root.findByType('Pressable');
    act(() => button.props.onPressIn(event));
    button.props.onPress();
    assert.equal(calls, 1);
    assert.equal(wash(renderer), undefined);
    assert.deepEqual(flatten(button.props.style), { padding: 2 });
  });

  it('pressing one Market row leaves its parent and both price renderers untouched', (t) => {
    const h = interactionHarness();
    let parents = 0, prices = 0;
    const { MarketAssetRow } = h.load('src/features/market/MarketAssetRow.tsx', {
      '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
      '../../components/states/AdminDiagnosticPanel': { default: () => null, __esModule: true },
      '../../utils/format': { getAssetNameDisplay: (item: any) => ({ primary: item.id }), getAssetSymbolMarketDisplay: () => '', getAssetPriceText: () => { prices++; return '100'; }, formatPercent: () => '0' },
    });
    function List() { parents++; return ['btc', 'eth'].map(id => React.createElement(MarketAssetRow, { key: id, item: { id, tradable: true, marketStatus: 'open' }, onPress() {} })); }
    const renderer = h.render(React.createElement(List));
    t.after(() => act(() => renderer.unmount()));
    const button = renderer.root.findAllByType('Pressable')[0];
    act(() => button.props.onPressIn(event));
    act(() => button.props.onPressOut(event));
    assert.equal(parents, 1);
    assert.equal(prices, 2);
    assert.equal(h.animations.length, 0);
  });
});
