import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { buttonFeedback, getFeedbackPalette } from './pressFeedback.ts';
import { semantic } from '../../theme/tokens.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const event = { nativeEvent: { pageX: 130, pageY: 215 } };
const wash = (renderer: any) => renderer.root.findAllByType('View').find((n: any) => n.props.pointerEvents === 'none');

describe('ActionPressable immediate feedback', () => {
  it('secondary CTA keeps solid colors, geometry and disabled/loading guards', (t) => {
    const h = interactionHarness();
    const CTA = h.load('src/components/common/CTAButton.tsx', { './ActionPressable': { default: h.ActionPressable, __esModule: true } }).default;
    const props = { label: '거래 내역 보기', onPress: () => {}, style: { flex: 1 } };
    const renderer = h.render(React.createElement(CTA, props));
    t.after(() => act(() => renderer.unmount()));
    const geometry = flatten(renderer.root.findByType('Pressable').props.style);
    act(() => renderer.update(React.createElement(CTA, { ...props, variant: 'secondary' })));
    assert.deepEqual(flatten(renderer.root.findByType('Pressable').props.style), geometry);
    assert.equal(renderer.root.findAllByType('Svg').length, 0);
    assert.equal(flatten(renderer.root.findAllByType('AnimatedView')[0].props.style).backgroundColor, semantic.secondaryActionSurface);
    assert.equal(flatten(renderer.root.findByType('Text').props.style).color, semantic.secondaryActionForeground);
    for (const state of ['disabled', 'loading', 'blocked']) {
      act(() => renderer.update(React.createElement(CTA, { ...props, variant: 'secondary', state })));
      const disabled = renderer.root.findByType('Pressable');
      assert.equal(disabled.props.disabled, true); assert.equal(disabled.props.onPress, undefined);
      assert.equal(disabled.props.accessibilityState.busy, state === 'loading');
      assert.equal(renderer.root.findAllByType('AnimatedView').length, 1, 'no wash');
      assert.equal(flatten(disabled.props.style).opacity, state === 'loading' ? undefined : 0.45);
      if (state === 'loading') assert.equal(renderer.root.findByType('ActivityIndicator').props.color, semantic.secondaryActionForeground);
    }
  });

  it('one full item target places immediate feedback only on its compact icon surface', (t) => {
    const h = interactionHarness();
    let calls = 0;
    const targetStyle = { alignSelf: 'stretch', alignItems: 'center', gap: 8 };
    const feedbackStyle = { width: 52, height: 52, borderRadius: 12, top: 0, alignSelf: 'center', backgroundColor: '#EAF4FC', zIndex: 1 };
    const props = { style: targetStyle, feedbackStyle, accessibilityRole: 'button', accessibilityLabel: '원장 보기', onPress: () => calls++ };
    const renderer = h.render(React.createElement(h.ActionPressable, props,
      React.createElement('View', { style: feedbackStyle, accessible: false }), React.createElement('Text', { accessible: false }, '원장 보기')));
    t.after(() => act(() => renderer.unmount()));
    const buttons = renderer.root.findAllByType('Pressable');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].findByType('Text').props.children, '원장 보기');
    act(() => buttons[0].props.onPressIn(event));
    const overlay = flatten(wash(renderer).props.style);
    for (const key of ['width', 'height', 'borderRadius', 'top', 'alignSelf', 'zIndex']) assert.equal(overlay[key], feedbackStyle[key]);
    assert.ok(overlay.opacity > 0);
    assert.equal(overlay.right, undefined);
    assert.deepEqual(flatten(buttons[0].props.style), targetStyle);
    buttons[0].props.onPress();
    assert.equal(calls, 1);
    act(() => buttons[0].props.onPressOut(event));
    assert.equal(flatten(wash(renderer).props.style).opacity, 0);
    act(() => renderer.update(React.createElement(h.ActionPressable, { ...props, disabled: true })));
    assert.equal(renderer.root.findByType('Pressable').props.onPress, undefined);
    assert.equal(wash(renderer), undefined);
    assert.equal(h.animations.length, 0);
  });

  for (const platform of ['android', 'ios', 'web']) {
    it(`${platform}: button uses one interruptible clock, stationary target, immediate actions and correct layer order`, (t) => {
      const h = interactionHarness(platform);
      let calls = 0;
      const onPress = () => calls++;
      const props = { primary: true, onPress, style: { width: 180, minHeight: 48, margin: 8, borderRadius: 12, padding: 14 }, hitSlop: 8 };
      const renderer = h.render(React.createElement(h.ActionPressable, props, React.createElement('Text', null, '실행')));
      t.after(() => act(() => renderer.unmount()));
      const button = () => renderer.root.findByType('Pressable');
      const surface = () => renderer.root.findAllByType('AnimatedView')[0];
      const overlay = () => renderer.root.findAllByType('AnimatedView')[1];
      const target = flatten(button().props.style);
      assert.deepEqual(target, { width: 180, minHeight: 48, margin: 8, borderRadius: 12 });
      assert.equal(button().props.hitSlop, 8); assert.equal(button().props.android_ripple, undefined);
      assert.equal(flatten(surface().props.style).padding, 14);
      assert.equal(renderer.root.findAllByType('Svg').length, 1);
      assert.equal(surface().findAllByType('View')[0].props.pointerEvents, 'none');
      assert.deepEqual(surface().children.map((n: any) => typeof n.type === 'function' ? n.type.name : n.type), ['PrimaryButtonBackground', 'AnimatedView', 'Text']);
      act(() => button().props.onPressIn(event));
      const press = h.animations.at(-1);
      assert.equal(press.options.toValue, 1); assert.equal(press.options.duration, buttonFeedback.pressDuration);
      assert.equal(press.options.useNativeDriver, platform !== 'web'); assert.equal(press.options.isInteraction, false);
      assert.equal(flatten(surface().props.style).transform[0].scale.value, flatten(overlay().props.style).opacity.value);
      assert.deepEqual(flatten(surface().props.style).transform[0].scale.outputRange, [1, 0.97]);
      assert.equal(flatten(surface().props.style).transform[0].scale.extrapolate, 'clamp');
      assert.equal(flatten(overlay().props.style).opacity.extrapolate, 'clamp');
      assert.deepEqual(flatten(overlay().props.style).opacity.outputRange, [0, 0.1]);
      assert.equal(flatten(overlay().props.style).backgroundColor, '#000');
      button().props.onPress(); assert.equal(calls, 1, 'handler runs before animation completion');
      assert.deepEqual(flatten(button().props.style), target);
      act(() => button().props.onPressOut(event));
      const release = h.animations.at(-1);
      assert.equal(release.options.duration, buttonFeedback.releaseDuration); assert.equal(release.options.toValue, 0);
      for (let i = 0; i < 5; i++) {
        act(() => button().props.onPressIn(event)); act(() => button().props.onPressOut(event));
      }
      h.finish(); assert.equal(press.value.value, 0); assert.equal(calls, 1, 'cancellation never invokes onPress');
      assert.deepEqual(flatten(button().props.style), target); assert.equal(h.measures.length, 0);
      act(() => button().props.onPressIn(event));
      h.reduced = true;
      act(() => renderer.update(React.createElement(h.ActionPressable, props, React.createElement('Text', null, '실행'))));
      const clocks = h.animations.length;
      act(() => button().props.onPressIn(event));
      assert.deepEqual(flatten(surface().props.style).transform, [{ scale: 1 }]);
      assert.equal(flatten(overlay().props.style).opacity, 0.1);
      act(() => button().props.onPressOut(event)); assert.equal(flatten(overlay().props.style).opacity, 0);
      assert.equal(h.animations.length, clocks);
      button().props.onPress(); assert.equal(calls, 2, 'keyboard/accessibility action needs no press animation');
      for (const blocked of [{ disabled: true }, { 'aria-disabled': true }, { accessibilityState: { disabled: true } }]) {
        act(() => renderer.update(React.createElement(h.ActionPressable, { ...props, ...blocked })));
        assert.equal(button().props.disabled, true); assert.equal(button().props.onPress, undefined);
        assert.equal(renderer.root.findAllByType('AnimatedView').length, 1);
        assert.equal(renderer.root.findAllByType('Svg').length, 0);
      }
    });
  }

  it('CTA neutral and financial roles stay solid while logout has independent red stops', (t) => {
    const h = interactionHarness();
    const CTA = h.load('src/components/common/CTAButton.tsx', { './ActionPressable': { default: h.ActionPressable, __esModule: true } }).default;
    const renderer = h.render(React.createElement(CTA, { label: '확인', onPress() {} }));
    t.after(() => act(() => renderer.unmount()));
    for (const props of [{ variant: 'neutral' }, { style: { backgroundColor: '#a13e3b' } }]) {
      act(() => renderer.update(React.createElement(CTA, { label: '확인', onPress() {}, ...props })));
      assert.equal(renderer.root.findAllByType('Svg').length, 0);
      if ('style' in props) assert.equal(flatten(renderer.root.findAllByType('AnimatedView')[0].props.style).backgroundColor, props.style.backgroundColor);
    }
    act(() => renderer.update(React.createElement(CTA, { label: '로그아웃', variant: 'logout', onPress() {} })));
    assert.deepEqual(renderer.root.findAllByType('Stop').map((n: any) => n.props.stopColor), ['#D93636', '#B82020']);
  });

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
      assert.equal(button().props.android_ripple, undefined);
      assert.equal(flatten(wash(renderer).props.style).opacity, 0);
      act(() => button().props.onPressIn(event));
      const overlay = wash(renderer);
      assert.equal(flatten(overlay.props.style).opacity, getFeedbackPalette(0xff111111).washOpacity);
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

  it('release/cancel, rapid taps, keyboard input and unmount leave no pending feedback', (t) => {
    const h = interactionHarness();
    let calls = 0;
    const renderer = h.render(React.createElement(h.ActionPressable, { onPress: () => calls++ }));
    t.after(() => act(() => renderer.unmount()));
    const button = () => renderer.root.findByType('Pressable');
    for (let tap = 0; tap < 5; tap++) {
      act(() => button().props.onPressIn({ nativeEvent: {} }));
      assert.equal(flatten(wash(renderer).props.style).opacity, getFeedbackPalette(null).washOpacity);
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
