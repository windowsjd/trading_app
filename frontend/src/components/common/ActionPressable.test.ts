import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { buttonFeedback, getFeedbackPalette, getRipplePalette, RIPPLE_BASE, rippleMotion, rippleScale } from './pressFeedback.ts';
import { semantic } from '../../theme/tokens.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const event = { nativeEvent: { pageX: 130, pageY: 215, locationX: 30, locationY: 15 } };
// The ripple layer: a hidden clipping View that measures its own surface.
const inkLayer = (renderer: any) => renderer.root.findAll((n: any) =>
  n.type === 'View' && n.props.accessibilityElementsHidden === true && typeof n.props.onLayout === 'function')[0];
const layoutInk = (renderer: any, width: number, height: number) =>
  act(() => inkLayer(renderer).props.onLayout({ nativeEvent: { layout: { width, height } } }));
const ink = (renderer: any) => flatten(inkLayer(renderer).findAllByType('AnimatedView')[0].props.style);
// The static selection tint (no ripple).
const wash = (renderer: any) => renderer.root.findAllByType('View').find((n: any) => n.props.pointerEvents === 'none' && !n.props.onLayout);
const isWhale = (n: any) => n.type?.name === 'WhaleLoader';

describe('ActionPressable touch feedback', () => {
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
      // The layer stays mounted (a fade in progress must finish) but shows no ink.
      assert.equal(ink(renderer).opacity.value.value, 0, 'no ink on a disabled button');
      assert.equal(flatten(disabled.props.style).opacity, state === 'loading' ? undefined : 0.45);
      const whales = renderer.root.findAll(isWhale);
      assert.equal(whales.length, state === 'loading' ? 1 : 0);
      if (state === 'loading') assert.equal(whales[0].props.tone, 'brand');
    }
  });

  it('a busy primary action keeps its brand background and shows the white whale (no black button)', (t) => {
    const h = interactionHarness();
    const CTA = h.load('src/components/common/CTAButton.tsx', { './ActionPressable': { default: h.ActionPressable, __esModule: true } }).default;
    const renderer = h.render(React.createElement(CTA, { label: '로그인', onPress() {}, state: 'loading' }));
    t.after(() => act(() => renderer.unmount()));
    const button = renderer.root.findByType('Pressable');
    assert.equal(button.props.disabled, true);
    assert.equal(renderer.root.findAll((n: any) => n.type?.name === 'PrimaryButtonBackground').length, 1);
    assert.deepEqual(renderer.root.findAllByType('Stop').map((n: any) => n.props.stopColor), ['#326FE5', '#4C32E5']);
    assert.equal(renderer.root.findAll(isWhale)[0].props.tone, 'onAction');
    act(() => renderer.update(React.createElement(CTA, { label: '로그인', onPress() {}, state: 'disabled' })));
    assert.equal(renderer.root.findAll((n: any) => n.type?.name === 'PrimaryButtonBackground').length, 0, 'disabled keeps the previous non-busy look');
  });

  it('one full item target inks only its compact icon surface, from its center', (t) => {
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
    const layer = flatten(inkLayer(renderer).props.style);
    for (const key of ['width', 'height', 'borderRadius', 'top', 'alignSelf', 'zIndex']) assert.equal(layer[key], feedbackStyle[key]);
    assert.equal(layer.overflow, 'hidden');
    assert.equal(layer.right, undefined);
    assert.equal(layer.backgroundColor, 'transparent', 'the ink layer never paints over the icon');
    layoutInk(renderer, 52, 52);
    act(() => buttons[0].props.onPressIn(event));
    assert.equal(ink(renderer).transform[0].translateX.value, 26 - RIPPLE_BASE / 2, 'compact surfaces ink from their center');
    assert.equal(ink(renderer).opacity.value.value, 1);
    assert.deepEqual(flatten(buttons[0].props.style), targetStyle);
    buttons[0].props.onPress();
    assert.equal(calls, 1);
    act(() => buttons[0].props.onPressOut(event));
    h.finish();
    assert.equal(ink(renderer).opacity.value.value, 0);
    assert.equal(h.measures.length, 0);
    act(() => renderer.update(React.createElement(h.ActionPressable, { ...props, disabled: true })));
    assert.equal(renderer.root.findByType('Pressable').props.onPress, undefined);
    assert.equal(ink(renderer).opacity.value.value, 0, 'a disabled surface shows no ink');
  });

  for (const platform of ['android', 'ios', 'web']) {
    it(`${platform}: button scales on one clock, inks from the touch point, keeps a stationary target and layer order`, (t) => {
      const h = interactionHarness(platform);
      let calls = 0;
      const onPress = () => calls++;
      const props = { primary: true, onPress, style: { width: 180, minHeight: 48, margin: 8, borderRadius: 12, padding: 14 }, hitSlop: 8 };
      const renderer = h.render(React.createElement(h.ActionPressable, props, React.createElement('Text', null, '실행')));
      t.after(() => act(() => renderer.unmount()));
      const button = () => renderer.root.findByType('Pressable');
      const surface = () => renderer.root.findAllByType('AnimatedView')[0];
      const target = flatten(button().props.style);
      assert.deepEqual(target, { width: 180, minHeight: 48, margin: 8, borderRadius: 12 });
      assert.equal(button().props.hitSlop, 8); assert.equal(button().props.android_ripple, undefined);
      assert.equal(flatten(surface().props.style).padding, 14);
      assert.equal(surface().props.pointerEvents, 'none', 'touch locations are relative to the target');
      assert.deepEqual(surface().children.map((n: any) => typeof n.type === 'function' ? n.type.name : n.type), ['PrimaryButtonBackground', 'InkRippleLayer', 'Text']);
      assert.equal(flatten(inkLayer(renderer).props.style).borderRadius, 12);
      assert.equal(inkLayer(renderer).props.importantForAccessibility, 'no-hide-descendants');
      layoutInk(renderer, 180, 48);
      act(() => button().props.onPressIn(event));
      const press = h.animations.find((a: any) => a.options.duration === buttonFeedback.pressDuration);
      const spread = h.animations.find((a: any) => a.options.duration === rippleMotion.spreadDuration);
      assert.equal(press.options.toValue, 1);
      assert.equal(press.options.useNativeDriver, platform !== 'web'); assert.equal(spread.options.useNativeDriver, platform !== 'web');
      assert.equal(press.options.isInteraction, false); assert.equal(spread.options.isInteraction, false);
      assert.deepEqual(flatten(surface().props.style).transform[0].scale.outputRange, [1, buttonFeedback.scale]);
      assert.equal(flatten(surface().props.style).transform[0].scale.extrapolate, 'clamp');
      // Ink: brand blue darkens; it starts at (30, 15) and reaches the farthest corner.
      const palette = getRipplePalette(0xff326fe5);
      assert.equal(ink(renderer).backgroundColor, palette.rippleColor);
      assert.deepEqual(ink(renderer).opacity.outputRange, [0, palette.rippleOpacity]);
      assert.equal(ink(renderer).transform[0].translateX.value, 30 - RIPPLE_BASE / 2);
      assert.equal(ink(renderer).transform[1].translateY.value, 15 - RIPPLE_BASE / 2);
      assert.equal(spread.options.toValue, (2 * Math.hypot(150, 33)) / RIPPLE_BASE);
      button().props.onPress(); assert.equal(calls, 1, 'handler runs before animation completion');
      assert.deepEqual(flatten(button().props.style), target);
      act(() => button().props.onPressOut(event));
      assert.ok(h.animations.some((a: any) => a.options.duration === buttonFeedback.releaseDuration && a.options.toValue === 0));
      assert.ok(h.animations.some((a: any) => a.options.duration === rippleMotion.fadeDuration && a.options.toValue === 0));
      for (let i = 0; i < 5; i++) {
        act(() => button().props.onPressIn(event)); act(() => button().props.onPressOut(event));
      }
      h.finish(); assert.equal(press.value.value, 0); assert.equal(ink(renderer).opacity.value.value, 0);
      assert.equal(calls, 1, 'cancellation never invokes onPress');
      assert.deepEqual(flatten(button().props.style), target); assert.equal(h.measures.length, 0);
      h.reduced = true;
      act(() => renderer.update(React.createElement(h.ActionPressable, props, React.createElement('Text', null, '실행'))));
      layoutInk(renderer, 180, 48);
      const clocks = h.animations.length;
      act(() => button().props.onPressIn(event));
      assert.deepEqual(flatten(surface().props.style).transform, [{ scale: 1 }]);
      assert.equal(ink(renderer).opacity.value.value, 1, 'Reduced Motion: a still, full tint');
      assert.equal(ink(renderer).transform[2].scale.value, rippleScale({ width: 180, height: 48 }, { x: 30, y: 15 }), 'covers at once');
      act(() => button().props.onPressOut(event)); assert.equal(ink(renderer).opacity.value.value, 0);
      assert.equal(h.animations.length, clocks);
      button().props.onPress(); assert.equal(calls, 2, 'keyboard/accessibility action needs no press animation');
      for (const blocked of [{ disabled: true }, { 'aria-disabled': true }, { accessibilityState: { disabled: true } }]) {
        act(() => renderer.update(React.createElement(h.ActionPressable, { ...props, ...blocked })));
        assert.equal(button().props.disabled, true); assert.equal(button().props.onPress, undefined);
        assert.equal(ink(renderer).opacity.value.value, 0, 'a blocked button shows no ink');
        assert.equal(renderer.root.findAllByType('Svg').length, 0);
      }
    });
  }

  it('press and release keep one native scale and ink node (no graph rebuilt as feedback starts)', (t) => {
    const h = interactionHarness();
    const renderer = h.render(React.createElement(h.ActionPressable, { primary: true, onPress() {}, style: { minHeight: 48, borderRadius: 12 } }));
    t.after(() => act(() => renderer.unmount()));
    layoutInk(renderer, 180, 48);
    const button = () => renderer.root.findByType('Pressable');
    const scale = () => flatten(renderer.root.findAllByType('AnimatedView')[0].props.style).transform[0].scale;
    const before = { scale: scale(), ink: ink(renderer).opacity };
    act(() => button().props.onPressIn(event));
    assert.equal(scale() === before.scale && ink(renderer).opacity === before.ink, true, 'pressed');
    act(() => button().props.onPressOut(event));
    assert.equal(scale() === before.scale && ink(renderer).opacity === before.ink, true, 'released');
  });

  // React Native stops an Animated value's running animation when the last view
  // using it unmounts (AnimatedValue.__detach → stopAnimation, RN and RN-web).
  const detachingHarness = () => {
    const h = interactionHarness();
    const stopAll = (node: unknown, seen = new Set<unknown>()): void => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (node instanceof h.native.Animated.Value) { (node as { stopAnimation(): void }).stopAnimation(); return; }
      for (const value of Object.values(node)) stopAll(value, seen);
    };
    function DetachingView({ style, ...props }: { style: unknown }) {
      const latest = React.useRef(style);
      latest.current = style;
      React.useEffect(() => () => stopAll(flatten(latest.current)), []);
      return React.createElement('AnimatedView', { ...props, style });
    }
    h.native.Animated = { ...h.native.Animated, View: DetachingView };
    const pressable = h.load('src/components/common/ActionPressable.tsx').default;
    const CTA = h.load('src/components/common/CTAButton.tsx', { './ActionPressable': { default: pressable, __esModule: true } }).default;
    return { h, CTA };
  };

  for (const releasedFirst of [true, false]) {
    it(`a press that turns the order button busy (${releasedFirst ? 'after release' : 'while held'}) leaves no frozen ink when it is enabled again`, (t) => {
      const { h, CTA } = detachingHarness();
      const props = { label: '롱(Long) 진입', onPress() {}, ripple: 'subtle', style: { backgroundColor: '#d1110b' } };
      const renderer = h.render(React.createElement(CTA, props));
      t.after(() => act(() => renderer.unmount()));
      layoutInk(renderer, 180, 48);
      const layer = inkLayer(renderer);
      act(() => renderer.root.findByType('Pressable').props.onPressIn(event));
      assert.equal(ink(renderer).opacity.value.value, 1);
      if (releasedFirst) act(() => renderer.root.findByType('Pressable').props.onPressOut(event));
      // The request starts (409 later): loading blocks the button mid-fade.
      act(() => renderer.update(React.createElement(CTA, { ...props, state: 'loading' })));
      assert.equal(renderer.root.findAll(isWhale).length, 1);
      assert.equal(inkLayer(renderer) === layer, true, 'the ink layer is not unmounted by the loading state');
      h.finish();
      act(() => renderer.update(React.createElement(CTA, props)));
      assert.equal(renderer.root.findByType('Pressable').props.disabled, false);
      assert.equal(ink(renderer).opacity.value.value, 0, 'no half-faded ink stays on the enabled button');
      // The next press inks normally again.
      act(() => renderer.root.findByType('Pressable').props.onPressIn(event));
      assert.equal(ink(renderer).opacity.value.value, 1);
      act(() => renderer.root.findByType('Pressable').props.onPressOut(event));
      h.finish();
      assert.equal(ink(renderer).opacity.value.value, 0);
    });
  }

  it('trade-executing buttons use a subtler ink of the same color', () => {
    for (const color of [0xffd1110b, 0xff0a5ac2, 0xff326fe5]) {
      const normal = getRipplePalette(color), subtle = getRipplePalette(color, 'subtle');
      assert.equal(subtle.rippleColor, normal.rippleColor);
      assert.ok(subtle.rippleOpacity < normal.rippleOpacity && subtle.rippleOpacity > 0);
    }
  });

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
    it(`${platform}: a row inks from the touch point inside it and keeps a single immediate action`, (t) => {
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
      assert.ok(ref.current, 'the caller ref still reaches the host');
      assert.strictEqual(button().props.onPress, onPress);
      assert.deepEqual(flatten(button().props.style), style);
      assert.equal(button().props.hitSlop, 8);
      assert.equal(button().props.accessibilityLabel, '주문');
      assert.equal(button().props.android_ripple, undefined);
      const layer = flatten(inkLayer(renderer).props.style);
      assert.equal(layer.borderRadius, 12); assert.equal(layer.overflow, 'hidden');
      assert.equal(inkLayer(renderer).props.importantForAccessibility, 'no-hide-descendants');
      layoutInk(renderer, 200, 60);
      act(() => button().props.onPressIn(event));
      const palette = getRipplePalette(0xff111111);
      assert.equal(palette.rippleColor, '#fff', 'a near-black neutral surface is lifted, not darkened');
      assert.equal(ink(renderer).backgroundColor, palette.rippleColor);
      if (platform === 'web') {
        // Web reports the location relative to this target already.
        assert.equal(h.measures.length, 0);
      } else {
        // Native coordinates may belong to a child: the row's page offset decides.
        assert.equal(h.measures.length, 1);
        assert.equal(ink(renderer).opacity.value.value, 0, 'nothing starts before the measurement');
        act(() => h.measures[0](0, 0, 200, 60, 100, 200));
      }
      assert.equal(ink(renderer).transform[0].translateX.value, 30 - RIPPLE_BASE / 2);
      assert.equal(ink(renderer).transform[1].translateY.value, 15 - RIPPLE_BASE / 2);
      assert.equal(ink(renderer).opacity.value.value, 1);
      assert.deepEqual(flatten(button().props.style), style, 'content geometry, opacity and shadow stay intact');
      assert.equal(renderer.root.findByType('Text').props.children, 'pressed');
      button().props.onPress(event);
      act(() => button().props.onPressOut(event));
      button().props.onLongPress(event);
      assert.deepEqual(calls, ['in', event, 'out', 'long']);
      h.finish();
      assert.equal(ink(renderer).opacity.value.value, 0);
      assert.equal(renderer.root.findByType('Text').props.children, 'idle');
      assert.equal(h.animations.every((a: any) => [rippleMotion.spreadDuration, rippleMotion.fadeDuration].includes(a.options.duration)), true,
        'rows never scale');
    });
  }

  it('a release before the native measurement still shows the ink briefly, then fades', (t) => {
    const h = interactionHarness('android');
    h.delayedMeasure = true;
    const renderer = h.render(React.createElement(h.ActionPressable, { onPress() {}, style: { backgroundColor: '#ffffff' } }));
    t.after(() => act(() => renderer.unmount()));
    layoutInk(renderer, 200, 60);
    const button = renderer.root.findByType('Pressable');
    act(() => button.props.onPressIn(event));
    act(() => button.props.onPressOut(event));
    act(() => h.measures[0](0, 0, 200, 60, 100, 200));
    assert.ok(h.animations.some((a: any) => a.options.duration === rippleMotion.fadeDuration && a.options.toValue === 0));
    h.finish();
    assert.equal(ink(renderer).opacity.value.value, 0);
  });

  it('resolves style callbacks and preserves string transforms and functional children', (t) => {
    const h = interactionHarness('web');
    const renderer = h.render(React.createElement(h.ActionPressable, {
      onPress() {}, style: ({ pressed }: { pressed: boolean }) => ({ backgroundColor: pressed ? '#fff' : '#111', transform: 'translateX(4px)', borderTopLeftRadius: 9 }),
    }, ({ pressed }: { pressed: boolean }) => React.createElement('Text', null, String(pressed))));
    t.after(() => act(() => renderer.unmount()));
    layoutInk(renderer, 120, 40);
    act(() => renderer.root.findByType('Pressable').props.onPressIn(event));
    assert.equal(ink(renderer).backgroundColor, '#000', 'the pressed (white) surface darkens');
    assert.equal(flatten(inkLayer(renderer).props.style).borderTopLeftRadius, 9);
    assert.equal(flatten(renderer.root.findByType('Pressable').props.style).transform, 'translateX(4px)');
    assert.equal(renderer.root.findByType('Text').props.children, 'true');
  });

  it('release/cancel, rapid taps, keyboard input and unmount leave no pending feedback', (t) => {
    const h = interactionHarness();
    let calls = 0;
    const renderer = h.render(React.createElement(h.ActionPressable, { onPress: () => calls++ }));
    t.after(() => act(() => renderer.unmount()));
    layoutInk(renderer, 200, 60);
    const button = () => renderer.root.findByType('Pressable');
    for (let tap = 0; tap < 5; tap++) {
      // No coordinates (keyboard/accessibility): inks from the center without measuring.
      act(() => button().props.onPressIn({ nativeEvent: {} }));
      assert.equal(ink(renderer).opacity.value.value, 1);
      assert.equal(ink(renderer).transform[0].translateX.value, 100 - RIPPLE_BASE / 2);
      act(() => button().props.onPressOut(event));
    }
    h.finish();
    assert.equal(ink(renderer).opacity.value.value, 0);
    assert.equal(calls, 0, 'scroll cancellation does not invoke the action');
    act(() => button().props.onPress());
    assert.equal(calls, 1);
    assert.equal(h.measures.length, 0);
  });

  it('selection controls keep one static tint without ink or motion', (t) => {
    const h = interactionHarness();
    const renderer = h.render(React.createElement(h.ActionPressable, { feedback: 'selection', onPress() {}, style: { borderRadius: 8 } }));
    t.after(() => act(() => renderer.unmount()));
    assert.equal(inkLayer(renderer) === undefined, true);
    act(() => renderer.root.findByType('Pressable').props.onPressIn(event));
    assert.equal(flatten(wash(renderer).props.style).opacity, getFeedbackPalette(null).washOpacity);
    act(() => renderer.root.findByType('Pressable').props.onPressOut(event));
    assert.equal(flatten(wash(renderer).props.style).opacity, 0);
    assert.equal(h.animations.length, 0); assert.equal(h.measures.length, 0);
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
    assert.equal(wash(renderer) === undefined, true);
    assert.equal(inkLayer(renderer) === undefined, true);
    assert.deepEqual(flatten(button.props.style), { padding: 2 });
  });

  it('pressing one Market row leaves its parent and both price renderers untouched', (t) => {
    const h = interactionHarness();
    // The rows just mounted: their ink layers answer measure, not onLayout yet.
    h.inkLayer = { size: [358, 72] };
    let parents = 0, prices = 0;
    const { MarketAssetRow } = h.load('src/features/market/MarketAssetRow.tsx', {
      '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
      '../../components/states/AdminDiagnosticPanel': { default: () => null, __esModule: true },
      '../../utils/format': { getAssetNameDisplay: (item: any) => ({ primary: item.id }), getAssetNameSubline: () => null, getAssetSymbolMarketDisplay: () => '', getAssetPriceText: () => { prices++; return '100'; }, formatPercent: () => '0' },
    });
    function List() { parents++; return ['btc', 'eth'].map(id => React.createElement(MarketAssetRow, { key: id, item: { id, tradable: true, marketStatus: 'open' }, onPress() {} })); }
    const renderer = h.render(React.createElement(List));
    t.after(() => act(() => renderer.unmount()));
    const button = renderer.root.findAllByType('Pressable')[0];
    act(() => button.props.onPressIn(event));
    act(() => button.props.onPressOut(event));
    assert.equal(parents, 1);
    assert.equal(prices, 2);
    assert.deepEqual(h.animations.map((a: any) => a.options.duration), [rippleMotion.spreadDuration, rippleMotion.fadeDuration],
      'only the pressed row\'s own ink moves: it spread, then faded');
    // The card's 1px border: its ink follows the border's inner curve (radius 12 - 1).
    assert.equal(flatten(inkLayer(renderer).props.style).borderRadius, 11);
  });
});

describe('ActionPressable: the first touch inks, and ink stays inside borders', () => {
  for (const platform of ['android', 'ios'] as const) {
    it(`${platform}: a press before the ink layer's first onLayout measures the layer and inks at once (buttons and rows)`, (t) => {
      const h = interactionHarness(platform);
      h.inkLayer = { size: [240, 50] };
      const button = h.render(React.createElement(h.ActionPressable, {
        feedback: 'button', onPress() {}, style: { backgroundColor: '#326FE5', borderRadius: 12, minHeight: 50 },
      }));
      t.after(() => act(() => button.unmount()));
      // No onLayout yet (layoutInk is never called).
      act(() => button.root.findByType('Pressable').props.onPressIn(event));
      assert.equal(ink(button).opacity.value.value, 1, 'the first touch inks');
      const spread = h.animations.find((a: any) => a.options.duration === rippleMotion.spreadDuration);
      assert.equal(spread?.options.toValue, rippleScale({ width: 240, height: 50 }, { x: 30, y: 15 }));
      act(() => button.root.findByType('Pressable').props.onPressOut(event));
      h.finish();
      assert.equal(ink(button).opacity.value.value, 0, 'and fades out');

      const r = interactionHarness(platform);
      r.inkLayer = { size: [358, 72] };
      const row = r.render(React.createElement(r.ActionPressable, {
        onPress() {}, style: { backgroundColor: '#ffffff', borderRadius: 12, borderWidth: 1, borderColor: '#e5e8eb' },
      }));
      t.after(() => act(() => row.unmount()));
      act(() => row.root.findByType('Pressable').props.onPressIn(event));
      // The row's page offset gives the origin (130 - 100, 215 - 200); the layer gives the size.
      assert.equal(ink(row).opacity.value.value, 1);
      assert.equal(ink(row).transform[0].translateX.value, 30 - RIPPLE_BASE / 2);
      assert.equal(ink(row).transform[1].translateY.value, 15 - RIPPLE_BASE / 2);
      assert.equal(r.animations.find((a: any) => a.options.duration === rippleMotion.spreadDuration)?.options.toValue,
        rippleScale({ width: 358, height: 72 }, { x: 30, y: 15 }));
    });
  }

  it('web: an asynchronous layer measurement still inks a press released before it answers, then fades', (t) => {
    const h = interactionHarness('web');
    h.inkLayer = { size: [200, 60], delayed: true };
    const renderer = h.render(React.createElement(h.ActionPressable, { onPress() {}, style: { backgroundColor: '#ffffff', borderRadius: 12 } }));
    t.after(() => act(() => renderer.unmount()));
    const target = renderer.root.findByType('Pressable');
    act(() => target.props.onPressIn(event));
    assert.deepEqual([h.inkMeasures.length, h.animations.length, ink(renderer).opacity.value.value], [1, 0, 0], 'waiting for the size');
    act(() => target.props.onPressOut(event));
    act(() => h.inkMeasures[0]());
    assert.equal(h.animations.some((a: any) => a.options.duration === rippleMotion.spreadDuration), true, 'it showed');
    assert.equal(h.animations.some((a: any) => a.options.duration === rippleMotion.fadeDuration && a.options.toValue === 0), true, 'then faded');
    h.finish();
    assert.equal(ink(renderer).opacity.value.value, 0, 'no ink is left behind');
    // The size is known now: the next press inks without measuring again.
    act(() => target.props.onPressIn(event));
    assert.deepEqual([h.inkMeasures.length, ink(renderer).opacity.value.value], [1, 1]);
  });

  it('a newer press wins over a measurement still on its way, and a zero size inks nothing', (t) => {
    const h = interactionHarness('web');
    h.inkLayer = { size: [200, 60], delayed: true };
    const renderer = h.render(React.createElement(h.ActionPressable, { onPress() {}, style: { backgroundColor: '#ffffff' } }));
    t.after(() => act(() => renderer.unmount()));
    const target = renderer.root.findByType('Pressable');
    act(() => target.props.onPressIn(event));
    act(() => target.props.onPressIn({ nativeEvent: { locationX: 150, locationY: 40 } }));
    act(() => h.inkMeasures[0]());
    assert.equal(h.animations.length, 0, 'the superseded answer starts nothing');
    act(() => h.inkMeasures[1]());
    assert.equal(h.animations.filter((a: any) => a.options.duration === rippleMotion.spreadDuration).length, 1);
    assert.equal(ink(renderer).transform[0].translateX.value, 150 - RIPPLE_BASE / 2, 'from the newer touch');

    const empty = interactionHarness('android');
    empty.inkLayer = { size: [0, 0] };
    const hidden = empty.render(React.createElement(empty.ActionPressable, { onPress() {}, style: { backgroundColor: '#ffffff' } }));
    t.after(() => act(() => hidden.unmount()));
    act(() => hidden.root.findByType('Pressable').props.onPressIn(event));
    act(() => hidden.root.findByType('Pressable').props.onPressOut(event));
    assert.deepEqual([empty.animations.length, ink(hidden).opacity.value.value], [0, 0]);
  });

  for (const fading of [false, true]) {
    it(`a new press never paints the previous ${fading ? 'still-fading' : 'faded'} spread ink at the new point, whichever native update a frame lands after`, (t) => {
      const h = interactionHarness('android');
      const renderer = h.render(React.createElement(h.ActionPressable, { onPress() {}, style: { backgroundColor: '#ffffff', borderRadius: 12, borderWidth: 1 } }));
      t.after(() => act(() => renderer.unmount()));
      layoutInk(renderer, 358, 72);
      const target = () => renderer.root.findByType('Pressable');
      act(() => target().props.onPressIn(event));
      act(() => target().props.onPressOut(event));
      if (fading) h.animations.find((a: any) => a.options.duration === rippleMotion.spreadDuration).finish();
      else h.finish();
      const { transform, opacity } = ink(renderer);
      const nodes: Record<string, any> = { spread: transform[2].scale, x: transform[0].translateX, y: transform[1].translateY, fade: opacity.value };
      const state: Record<string, number> = Object.fromEntries(Object.entries(nodes).map(([key, node]) => [key, node.value]));
      assert.deepEqual([state.fade > 0, state.spread > rippleMotion.startScale], [fading, true], 'the previous ink covers the row');
      const from = h.sets.length;
      act(() => target().props.onPressIn({ nativeEvent: { pageX: 400, pageY: 260, locationX: 300, locationY: 60 } }));
      const updates: [string, number][] = h.sets.slice(from).flatMap(([node, value]: [unknown, number]) => {
        const key = Object.keys(nodes).find((name) => nodes[name] === node);
        return key ? [[key, value]] : [];
      });
      assert.deepEqual(updates, [['spread', rippleMotion.startScale], ['x', 300 - RIPPLE_BASE / 2], ['y', 60 - RIPPLE_BASE / 2], ['fade', 1]]);
      // A frame between two updates paints what the earlier ones left.
      updates.slice(0, -1).forEach(([key, value], index) => {
        state[key] = value;
        assert.equal(state.fade > 0 && state.spread > rippleMotion.startScale, false, `a frame after ${index + 1} update(s)`);
      });
    });
  }

  it('a layer inside a bordered surface follows the border\'s inner curve; a compact surface keeps its own corners', (t) => {
    const h = interactionHarness('android');
    const render = (props: Record<string, unknown>) => {
      const renderer = h.render(React.createElement(h.ActionPressable, { onPress() {}, ...props }));
      t.after(() => act(() => renderer.unmount()));
      return renderer;
    };
    const radii = (style: any) => [style.borderRadius, style.borderTopLeftRadius, style.borderBottomRightRadius];
    // Rows/cards: the ink fill starts inside the border.
    assert.deepEqual(radii(flatten(inkLayer(render({ style: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1 } })).props.style)),
      [11, undefined, undefined]);
    assert.deepEqual(radii(flatten(inkLayer(render({ style: { backgroundColor: '#fff', borderTopLeftRadius: 14, borderBottomRightRadius: 2, borderWidth: 3 } })).props.style)),
      [undefined, 11, 0], 'per corner, never below zero');
    // Uneven sides: a corner takes its own sides' width; one radius for all takes the thinnest
    // side, so a corner without a border (the top-only separator's bottom) never leaves the outline.
    assert.deepEqual(radii(flatten(inkLayer(render({ style: { backgroundColor: '#fff', borderRadius: 12, borderTopWidth: 1 } })).props.style)),
      [12, undefined, undefined]);
    assert.deepEqual(radii(flatten(inkLayer(render({ style: { backgroundColor: '#fff', borderTopLeftRadius: 12, borderBottomRightRadius: 12, borderTopWidth: 2, borderWidth: 1 } })).props.style)),
      [undefined, 10, 11]);
    assert.equal(flatten(inkLayer(render({ style: { backgroundColor: '#fff', borderTopStartRadius: 12, borderStartWidth: 2, borderLeftWidth: 5, borderWidth: 1 } })).props.style).borderTopStartRadius,
      10, 'the start side wins over the left side');
    assert.equal(flatten(inkLayer(render({ style: { backgroundColor: '#fff', borderRadius: 12 } })).props.style).borderRadius, 12, 'no border, no change');
    assert.equal(flatten(inkLayer(render({ style: { backgroundColor: '#fff', borderRadius: '50%', borderWidth: 1 } })).props.style).borderRadius, '50%');
    // The selection tint on a bordered control.
    const selection = render({ feedback: 'selection', style: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1 } });
    assert.equal(flatten(wash(selection).props.style).borderRadius, 11);
    // A compact surface is its own (unbordered) box.
    const compact = render({ style: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1 },
      feedbackStyle: { top: 4, left: 4, width: 40, height: 40, borderRadius: 20, borderWidth: 1 } });
    assert.equal(flatten(inkLayer(compact).props.style).borderRadius, 20);
    // Buttons: a bordered surface (the learning-locked CTA) inks inside its border.
    assert.equal(flatten(inkLayer(render({ feedback: 'button', style: { backgroundColor: '#f7f8fa', borderRadius: 12, borderWidth: 1 } })).props.style).borderRadius, 11);
    assert.equal(flatten(inkLayer(render({ feedback: 'button', style: { backgroundColor: '#326FE5', borderRadius: 12 } })).props.style).borderRadius, 12);
  });
});
