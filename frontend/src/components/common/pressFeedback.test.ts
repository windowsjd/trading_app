import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import {
  getFeedbackPalette,
  getRippleGeometry,
  PRESS_IN_DURATION_MS,
  PRESS_IN_SCALE,
  PRESS_OUT_DURATION_MS,
  RIPPLE_EXPAND_DURATION_MS,
  RIPPLE_FADE_DURATION_MS,
} from './pressFeedback.ts';

const require = createRequire(import.meta.url);
const { load, elements } = require('../../../test/ledgerTestHarness.cjs');
const { interactionHarness, flatten, React, act } = require('../../../test/interactionTestHarness.cjs');
const native = {
  Pressable: 'Pressable', Text: 'Text', ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal', View: 'View', StyleSheet: { create: (styles: unknown) => styles },
};
const event = { nativeEvent: { pageX: 130, pageY: 215, locationX: 3, locationY: 4 } };
const circle = (renderer: any) => renderer.root.findAllByType('AnimatedView').find((n: any) => n.props.style.width !== undefined);
const wash = (renderer: any) => flatten(renderer.root.findAllByType('AnimatedView')[0].props.style);

describe('general ripple interaction', () => {
  for (const platform of ['android', 'ios', 'web']) {
    it(`${platform}: touch origin, expansion, neutral lightening and restoration without delaying the action`, (t) => {
      const h = interactionHarness(platform);
      const calls: string[] = [];
      const onPress = () => calls.push('press');
      const style = {
        backgroundColor: '#111', borderRadius: 12, padding: 14,
        shadowOpacity: 0.2, elevation: 4, transform: [{ translateX: 2 }],
      };
      const renderer = h.render(React.createElement(h.ActionPressable, {
        style, onPress, onPressIn: () => calls.push('in'), onPressOut: () => calls.push('out'),
        testID: 'action', accessibilityRole: 'button', accessibilityLabel: '실행',
      }, React.createElement('Text', null, '실행')));
      t.after(() => act(() => renderer.unmount()));
      const button = renderer.root.findByType('Pressable');
      const rootStyle = flatten(button.props.style);
      const pressScale = rootStyle.transform.at(-1).scale;
      assert.equal(rootStyle.padding, 14, 'root layout is untouched');
      assert.equal(rootStyle.shadowOpacity, 0.2, 'root shadow is untouched');
      assert.equal(rootStyle.elevation, 4);
      assert.deepEqual(rootStyle.transform[0], { translateX: 2 });
      assert.equal(pressScale.value, 1);
      assert.strictEqual(button.props.onPress, onPress);
      assert.equal(button.props.testID, 'action');
      assert.equal(button.props.accessibilityLabel, '실행');
      act(() => button.props.onPressIn(event));
      const ripple = circle(renderer).props.style;
      assert.equal(ripple.left + ripple.width / 2, 30, 'pageX minus rootX, not child locationX');
      assert.equal(ripple.top + ripple.height / 2, 15);
      assert.ok(ripple.width / 2 >= Math.hypot(170, 45), 'covers the farthest corner');
      assert.equal(ripple.transform[0].scale.value, 0.02);
      assert.equal(wash(renderer).backgroundColor, '#fff');
      assert.deepEqual(wash(renderer).opacity.outputRange, [0, 0.045]);
      assert.equal(wash(renderer).opacity.value.value, 1, 'lightening starts on touch');
      assert.equal(ripple.backgroundColor, 'rgba(255,255,255,0.16)');
      const clip = renderer.root.findAllByType('View').find((n: any) => n.props.pointerEvents === 'none');
      assert.equal(flatten(clip.props.style).overflow, 'hidden');
      assert.equal(flatten(clip.props.style).borderRadius, 12);
      assert.equal((style as any).opacity, undefined);
      assert.equal((style as any).overflow, undefined);
      assert.equal(clip.props.accessibilityElementsHidden, true);
      const pressInAnimation = h.animations.find(
        (animation: any) => animation.value === pressScale,
      );
      const expansion = h.animations.find(
        (animation: any) => animation.value === ripple.transform[0].scale,
      );
      assert.equal(pressInAnimation.options.toValue, PRESS_IN_SCALE);
      assert.equal(pressInAnimation.options.duration, PRESS_IN_DURATION_MS);
      assert.equal(expansion.options.toValue, 1);
      assert.equal(expansion.options.duration, RIPPLE_EXPAND_DURATION_MS);
      assert.ok(expansion.options.duration > 240);
      assert.equal(expansion.options.useNativeDriver, platform !== 'web');
      assert.equal(expansion.options.isInteraction, false);
      act(() => pressInAnimation.finish());
      assert.equal(pressScale.value, PRESS_IN_SCALE);
      assert.deepEqual(calls, ['in']);
      button.props.onPress();
      assert.deepEqual(calls, ['in', 'press'], 'onPress runs once before animation completion');
      act(() => button.props.onPressOut(event));
      assert.deepEqual(calls, ['in', 'press', 'out']);
      const release = h.animations.find(
        (animation: any) =>
          animation.value === pressScale && animation.options.toValue === 1,
      );
      assert.equal(release.options.duration, PRESS_OUT_DURATION_MS);
      assert.equal(
        h.animations.some(
          (animation: any) =>
            animation.value === ripple.opacity && animation.options.toValue === 0,
        ),
        false,
        'quick release does not fade before expansion completes',
      );
      act(() => expansion.finish());
      const fade = h.animations.find(
        (animation: any) =>
          animation.value === ripple.opacity && animation.options.toValue === 0,
      );
      assert.equal(fade.options.duration, RIPPLE_FADE_DURATION_MS);
      assert.ok(circle(renderer), 'completed expansion remains visible while fading');
      act(() => release.finish());
      assert.equal(pressScale.value, 1);
      h.finish();
      assert.equal(circle(renderer), undefined);
      assert.equal(wash(renderer).opacity.value.value, 0);
      assert.equal(flatten(button.props.style).padding, 14);
    });
  }

  it('uses current root bounds after scrolling, clamps edges and centers keyboard presses', () => {
    assert.deepEqual(getRippleGeometry(130, 215, { pageX: 100, pageY: 200, width: 200, height: 60 }), { x: 30, y: 15, radius: Math.hypot(170, 45) });
    assert.equal(getRippleGeometry(130, 215, { pageX: 100, pageY: 180, width: 200, height: 60 }).y, 35);
    assert.equal(getRippleGeometry(0, 0, { pageX: 100, pageY: 200, width: 200, height: 60 }).x, 0);
    assert.deepEqual(getRippleGeometry(undefined, undefined, { pageX: 100, pageY: 200, width: 200, height: 60 }), { x: 100, y: 30, radius: Math.hypot(100, 30) });
  });

  it('lightens dark/blue/gray surfaces with a weaker neutral wash and leaves white alone', () => {
    for (const color of [0xff111111, 0xff0066cc, 0xffcccccc]) {
      assert.deepEqual(getFeedbackPalette(color), { washOpacity: 0.045, rippleColor: 'rgba(255,255,255,0.16)' });
    }
    for (const color of [0xfffafafa, 0xffffffff, null]) {
      assert.deepEqual(getFeedbackPalette(color), { washOpacity: 0, rippleColor: 'rgba(0,0,0,0.10)' });
    }
  });

  it('CTA and direct buttons use the same component, preserving pending states and wrapping', (t) => {
    const h = interactionHarness();
    const CTA = h.load('src/components/common/CTAButton.tsx', { './ActionPressable': { default: h.ActionPressable, __esModule: true } }).default;
    const onPress = () => {};
    const cta = CTA({ label: '환전하기', onPress, testID: 'cta' });
    assert.strictEqual(cta.type, h.ActionPressable);
    const renderer = h.render(cta);
    t.after(() => act(() => renderer.unmount()));
    act(() => renderer.root.findByType('Pressable').props.onPressIn(event));
    assert.ok(circle(renderer));
    assert.equal(wash(renderer).opacity.value.value, 1);
    assert.equal(renderer.root.findByType('Text').props.numberOfLines, undefined);
    for (const state of ['disabled', 'loading', 'blocked']) {
      act(() => renderer.update(React.createElement(CTA, { label: '환전하기', state, onPress })));
      const button = renderer.root.findByType('Pressable');
      assert.equal(button.props.disabled, true);
      assert.equal(button.props.onPress, undefined);
      const count = h.animations.length;
      act(() => { button.props.onPressIn(event); button.props.onPressOut(event); });
      assert.equal(h.animations.length, count);
      assert.equal(renderer.root.findAllByType('AnimatedView').length, 0);
      assert.equal(renderer.root.findAllByType('ActivityIndicator').length, state === 'loading' ? 1 : 0);
    }
    act(() => renderer.update(React.createElement(h.ActionPressable, { style: { backgroundColor: '#111' } }, '준비 중')));
    act(() => renderer.root.findByType('Pressable').props.onPressIn(event));
    assert.equal(renderer.root.findAllByType('AnimatedView').length, 0, 'no handler, no feedback');
  });

  it('cancels release/scroll feedback and ignores stale measurements and old animation completion', (t) => {
    const h = interactionHarness();
    h.delayedMeasure = true;
    let calls = 0;
    const props = { onPress: () => calls++, style: { backgroundColor: '#eee' } };
    const renderer = h.render(React.createElement(h.ActionPressable, props));
    t.after(() => act(() => renderer.unmount()));
    const button = () => renderer.root.findByType('Pressable');
    act(() => button().props.onPressIn(event));
    act(() => button().props.onPressOut(event));
    act(() => h.measures.shift()(...h.bounds));
    h.finish();
    assert.equal(circle(renderer), undefined);
    assert.equal(
      flatten(button().props.style).transform.at(-1).scale.value,
      1,
      'cancel restores the root scale',
    );
    assert.equal(calls, 0, 'cancel is not an action');
    h.delayedMeasure = false;
    act(() => button().props.onPressIn(event));
    act(() => button().props.onPressOut(event));
    const oldRipple = circle(renderer).props.style;
    const oldExpansion = h.animations.findLast(
      (animation: any) => animation.value === oldRipple.transform[0].scale,
    );
    act(() => oldExpansion.finish());
    const oldFade = h.animations.findLast(
      (animation: any) =>
        animation.value === oldRipple.opacity && animation.options.toValue === 0,
    );
    act(() => button().props.onPressIn({ nativeEvent: { pageX: 180, pageY: 220 } }));
    act(() => oldFade.callback({ finished: true }));
    assert.ok(circle(renderer), 'old release cannot remove a new ripple');
    assert.equal(circle(renderer).props.style.left + circle(renderer).props.style.width / 2, 80);
    h.delayedMeasure = true;
    act(() => button().props.onPressIn(event));
    act(() => renderer.update(React.createElement(h.ActionPressable, { ...props, disabled: true })));
    act(() => h.measures.shift()(...h.bounds));
    assert.equal(renderer.root.findAllByType('AnimatedView').length, 0);
    assert.equal(flatten(button().props.style).transform.at(-1).scale.value, 1);
  });

  it('invalidates measurement and animation callbacks when navigation unmounts the action', () => {
    const h = interactionHarness();
    h.delayedMeasure = true;
    const renderer = h.render(
      React.createElement(h.ActionPressable, { onPress: () => {} }),
    );
    const button = renderer.root.findByType('Pressable');
    act(() => button.props.onPressIn(event));
    const lateMeasure = h.measures.shift();

    act(() => renderer.unmount());

    assert.doesNotThrow(() => act(() => lateMeasure(...h.bounds)));
    assert.doesNotThrow(() => h.finish());
  });

  it('never makes a quick tap wait for measurement, and never revives a finished ripple', (t) => {
    const h = interactionHarness();
    h.delayedMeasure = true;
    let calls = 0;
    const renderer = h.render(React.createElement(h.ActionPressable, { onPress: () => calls++ }));
    t.after(() => act(() => renderer.unmount()));
    const button = renderer.root.findByType('Pressable');
    act(() => button.props.onPressIn(event));
    act(() => button.props.onPressOut(event));
    button.props.onPress();
    assert.equal(calls, 1);
    act(() => h.measures.shift()(...h.bounds));
    const ripple = circle(renderer).props.style;
    const expansion = h.animations.find(
      (animation: any) => animation.value === ripple.transform[0].scale,
    );
    assert.ok(circle(renderer), 'a fast tap still gets its ripple expansion');
    assert.equal(
      h.animations.some(
        (animation: any) =>
          animation.value === ripple.opacity && animation.options.toValue === 0,
      ),
      false,
      'pressOut does not immediately remove a quick-tap ripple',
    );
    act(() => expansion.finish());
    assert.ok(circle(renderer), 'ripple fades only after expansion');
    h.finish();
    assert.equal(circle(renderer), undefined);
    act(() => button.props.onPressIn(event));
    act(() => button.props.onPressOut(event));
    h.finish();
    act(() => h.measures.shift()(...h.bounds));
    assert.equal(circle(renderer), undefined, 'late native callbacks cannot restart a finished effect');
  });

  it('pressing a market row never rerenders its parent or sibling price content', (t) => {
    const h = interactionHarness();
    let parentRenders = 0;
    let prices = 0;
    const { MarketAssetRow } = h.load('src/features/market/MarketAssetRow.tsx', {
      '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
      '../../utils/format': {
        getAssetNameDisplay: (item: any) => ({ primary: item.id }), getAssetSymbolMarketDisplay: () => '',
        getAssetPriceText: () => { prices++; return '100'; }, formatPercent: () => '0',
      },
    });
    function List() {
      parentRenders++;
      return ['btc', 'eth'].map((id) => React.createElement(MarketAssetRow, { key: id, item: { id, tradable: true, marketStatus: 'open' }, onPress: () => {} }));
    }
    const renderer = h.render(React.createElement(List));
    t.after(() => act(() => renderer.unmount()));
    assert.equal(prices, 2);
    const button = renderer.root.findAllByType('Pressable')[0];
    act(() => button.props.onPressIn(event));
    assert.ok(circle(renderer));
    act(() => button.props.onPressOut(event));
    h.finish();
    assert.equal(parentRenders, 1);
    assert.equal(prices, 2);
  });
});

describe('touch coverage and exclusions', () => {
  it('covers direct action Pressables and uses their existing disabled condition', () => {
    const covered = new Set<string>();
    const excluded: string[] = [];
    for (const file of readdirSync('src', { recursive: true }) as string[]) {
      if (!file.endsWith('.tsx')) continue;
      const source = ts.createSourceFile(file, readFileSync(resolve('src', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ['Pressable', 'ActionPressable'].includes(node.tagName.getText(source))) {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
          const attr = (name: string) => attrs.find((a) => a.name.getText(source) === name);
          const expression = (name: string) => {
            const init = attr(name)?.initializer;
            return init && ts.isJsxExpression(init) ? init.expression : undefined;
          };
          const style = expression('style');
          if (file === 'components/common/ActionPressable.tsx') return;
          if (file === 'components/common/BottomSheetBackdrop.tsx' || !attr('onPress')) {
            excluded.push(file);
            assert.ok(style && !ts.isCallExpression(style), `${file}: non-action keeps its static style`);
          } else {
            assert.equal(node.tagName.getText(source), 'ActionPressable', `${file}: missing common interaction`);
            assert.match(readFileSync(resolve('src', file), 'utf8'), /import ActionPressable from ['"].*\/ActionPressable['"]/);
            assert.ok(style && !ts.isCallExpression(style), `${file}: base style stays static`);
            covered.add(file);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    assert.deepEqual(excluded.sort(), [
      'components/common/BottomSheetBackdrop.tsx',
      'screens/record/RecordOrderListScreen.tsx',
    ]);
    for (const file of [
      'components/common/CTAButton.tsx', 'components/tradingAccount/AccountSwitcher.tsx',
      'components/charts/ChartTimeframeSelector.tsx',
      'components/states/ErrorState.tsx', 'features/market/MarketAssetRow.tsx',
      'screens/auth/LoginScreen.tsx', 'screens/auth/SignupScreen.tsx',
      'screens/home/GeneralAccountHome.tsx', 'screens/home/SeasonAccountHome.tsx',
      'screens/market/MarketScreen.tsx', 'screens/market/MarketSearchScreen.tsx',
      'screens/ranking/RankingScreen.tsx', 'screens/my/MyScreen.tsx',
      'screens/order/OrderScreen.tsx', 'screens/wallet/WalletFxScreen.tsx',
    ]) assert.ok(covered.has(file), file);
  });

  it('leaves backdrop dismissal and its transparent touch surface unchanged', () => {
    const Backdrop = load(resolve('src/components/common/BottomSheetBackdrop.tsx'), { 'react-native': native }).default;
    let closes = 0;
    const onClose = () => { closes++; };
    const tree = Backdrop({ visible: true, onClose, children: 'sheet content' });
    const backdrop = elements(tree, 'Pressable')[0];
    assert.deepEqual(backdrop.props.style, { flex: 1 });
    assert.equal(backdrop.props.android_ripple, undefined);
    assert.strictEqual(backdrop.props.onPress, onClose);
    assert.strictEqual(tree.props.onRequestClose, onClose);
    backdrop.props.onPress();
    assert.equal(closes, 1);
  });

  it('keeps feedback outside the chart gesture subtree', () => {
    const read = (file: string) => readFileSync(resolve('src/components/charts', file), 'utf8');
    for (const file of ['CandlestickGestures.native.tsx', 'CandlestickGestures.web.tsx', 'CandlestickChartRenderer.tsx']) {
      assert.doesNotMatch(read(file), /ActionPressable|<Pressable|android_ripple/);
    }
    const source = read('CandlestickChart.tsx');
    const gestureStart = source.indexOf('<CandlestickGestures');
    const gestureEnd = source.indexOf('</CandlestickGestures>');
    assert.ok(gestureStart > 0 && gestureEnd > gestureStart);
    assert.doesNotMatch(source.slice(gestureStart, gestureEnd), /ActionPressable|<Pressable/);
    assert.match(source.slice(gestureEnd), /<ActionPressable\s+style=\{styles.resetButton\}/);
    assert.equal((source.match(/<ActionPressable/g) ?? []).length, 1);
  });

  it('preserves market row memoization across unrelated ticker updates', () => {
    const React = require('react');
    const { MarketAssetRow } = load(resolve('src/features/market/MarketAssetRow.tsx'), {
      react: { ...React, useMemo: (fn: () => unknown) => fn() }, 'react-native': native,
    });
    const props = { item: { id: 'btc' }, ticker: { assetId: 'btc' }, isStale: false, onPress: () => {} };
    assert.equal(MarketAssetRow.compare(props, { ...props }), true);
    assert.equal(MarketAssetRow.compare(props, { ...props, ticker: { ...props.ticker } }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, isStale: true }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, item: { ...props.item } }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, onPress: () => {} }), false);
  });
});
