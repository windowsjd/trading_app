import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { tabTransition } from '../../app/navigation/transitionPolicy.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { load, elements } = require('../../../test/ledgerTestHarness.cjs');

function harness(platform: string, mode: 'general' | 'season' = 'general', reducedMotion = false) {
  const animations: any[] = [];
  const native = {
    Platform: { OS: platform, Version: 35 },
    Pressable: 'Pressable',
    Easing: { inOut: (value: unknown) => value, quad: 'quad' },
    Animated: {
      createAnimatedComponent: () => 'AnimatedPressable',
      Value: class {
        value: number;
        constructor(value: number) { this.value = value; }
      },
      timing: (_value: unknown, options: unknown) => ({ start: () => animations.push(options) }),
    },
  };
  // Exercise the installed Navigation button, mocking only hooks/native animation.
  const { PlatformPressable } = load(resolve(dirname(require.resolve('@react-navigation/elements/package.json')), 'src/PlatformPressable.tsx'), {
    react: { ...React, useState: (initial: () => unknown) => [initial(), () => {}] },
    'react-native': native,
    '@react-navigation/native': { useTheme: () => ({ dark: false }) },
  });
  const Button = load(resolve('src/components/navigation/TabBarButton.tsx'), {
    '@react-navigation/elements': { PlatformPressable },
    '../../theme/appearance': { useAppearance: () => ({ colors: { pressed: '#202a3520' } }) },
  }).default;
  const dimensions = { fontScale: 1 };
  const insets = { bottom: 34 };
  const MainTabs = load(resolve('src/app/navigation/MainTabs.tsx'), {
    'react-native': { useWindowDimensions: () => dimensions },
    'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
    '@react-navigation/native': { getFocusedRouteNameFromRoute: route => route.params?.screen },
    '@react-navigation/bottom-tabs': { createBottomTabNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
    '../../theme/appearance': { useAppearance: () => ({ colors: { navigation: '#ffffff', navigationActive: '#202a35', navigationInactive: '#697583', navigationHomeInactive: '#111111', border: '#dfe4e9' } }) },
    '../../theme/useReducedMotion': { useReducedMotion: () => reducedMotion },
    '../../components/navigation/TabBarButton': { default: Button, __esModule: true },
    '../../components/navigation/TabBarIcon': { default: 'TabBarIcon', __esModule: true },
    '../../components/states/FullPageLoading': { default: 'FullPageLoading', __esModule: true },
    '../../features/tradingAccount/TradingAccountContext': {
      useTradingAccount: () => ({ selectedAccount: { id: 'account-1', mode }, isLoading: false }),
    },
    ...Object.fromEntries(['Home', 'Market', 'Guide', 'Ranking', 'Wallet', 'My'].map((name) => [
      `./${name}Stack`, { default: `${name}Stack`, __esModule: true },
    ])),
  }).default;
  return { MainTabs, dimensions, insets, animations };
}

describe('bottom tab touch feedback', () => {
  for (const platform of ['android', 'ios', 'web']) {
    for (const mode of ['general', 'season'] as const) {
      it(`${platform}/${mode}: connects all five tabs while preserving events, icons and accessibility`, () => {
        const h = harness(platform, mode);
        const tree = h.MainTabs();
        const policy = tabTransition(false);
        assert.equal(tree.props.screenOptions.animation, policy.animation);
        assert.deepEqual(tree.props.screenOptions.transitionSpec, policy.transitionSpec);
        const screens = elements(tree, 'Screen');
        assert.deepEqual(screens.map((node: any) => node.props.name), [
          'HomeTab',
          'MarketTab',
          mode === 'general' ? 'GuideTab' : 'RankingTab',
          'WalletTab',
          'MyTab',
        ]);
        for (const screen of screens) {
          const options = typeof screen.props.options === 'function'
            ? screen.props.options({ route: { name: screen.props.name, params: { screen: 'Market' } } })
            : screen.props.options;
          for (const selected of [false, true]) {
            const icon = options.tabBarIcon({ color: selected ? '#fff' : '#aaa', size: 25, focused: selected });
            assert.equal(icon.props.color, selected ? '#fff' : screen.props.name === 'HomeTab' ? '#111111' : '#aaa');
            assert.equal(icon.props.size, 25);
            assert.equal(icon.props.focused, selected);
            const calls: string[] = [];
            const props = {
              onPress: () => calls.push('press'), onLongPress: () => calls.push('longPress'),
              onPressIn: () => calls.push('in'), onPressOut: () => calls.push('out'),
              style: [{ flex: 1, padding: 5 }], children: icon, href: `/${screen.props.name}`,
              role: platform === 'ios' ? 'button' : 'tab',
              'aria-label': options.title, 'aria-selected': selected,
              testID: screen.props.name, accessibilityState: { selected },
              android_ripple: { borderless: true }, pressOpacity: 1,
            };
            const element = tree.props.screenOptions.tabBarButton(props);
            const button = element.type(element.props);
            for (const key of ['onPress', 'onLongPress', 'onPressIn', 'onPressOut', 'style', 'children', 'href', 'role', 'aria-label', 'aria-selected', 'testID', 'accessibilityState']) {
              assert.strictEqual(button.props[key], props[key as keyof typeof props], key);
            }
            const host = button.type.render(button.props, null);
            const event = { preventDefault: () => {}, button: 0 };
            h.animations.length = 0;
            host.props.onPressIn(event);
            if (platform === 'android') {
              assert.deepEqual(host.props.android_ripple, { color: '#202a3520', borderless: false });
              assert.equal(h.animations.length, 0);
            } else {
              assert.equal(h.animations[0].toValue, 0.82);
              assert.equal(h.animations[0].duration, 0, 'feedback starts immediately');
            }
            assert.deepEqual(calls, ['in']);
            host.props.onPress(event);
            assert.deepEqual(calls, ['in', 'press'], 'navigation fires synchronously once');
            host.props.onPressOut(event);
            if (platform !== 'android') assert.equal(h.animations.at(-1).toValue, 1);
            host.props.onLongPress(event);
            assert.deepEqual(calls, ['in', 'press', 'out', 'longPress']);

            const disabled = button.type.render({ ...button.props, disabled: true }, null);
            assert.equal(disabled.props.onPress, undefined);
            assert.equal(disabled.props.onPressIn, undefined);
            assert.equal(disabled.props.android_ripple, undefined);
          }
        }
      });
    }
  }

  it('keeps the existing large-font and safe-area layout policy', () => {
    const h = harness('ios');
    assert.deepEqual(h.MainTabs().props.screenOptions.tabBarStyle, { backgroundColor: '#ffffff', borderTopColor: '#dfe4e9' });
    h.dimensions.fontScale = 2.4;
    const options = h.MainTabs().props.screenOptions;
    assert.equal(options.tabBarLabelPosition, 'below-icon');
    assert.deepEqual(options.tabBarStyle, { backgroundColor: '#ffffff', borderTopColor: '#dfe4e9', height: 49 + Math.ceil(14 * 1.4) + h.insets.bottom });
  });

  for (const platform of ['android', 'ios', 'web']) {
    it(`${platform}: Reduced Motion suppresses both tab fade and visible press animation`, () => {
      const h = harness(platform, 'general', true);
      const options = h.MainTabs().props.screenOptions;
      assert.equal(options.animation, 'none');
      assert.equal(options.transitionSpec.config.duration, 0);
      let calls = 0;
      const element = options.tabBarButton({ onPress: () => calls++, style: { flex: 1 }, android_ripple: { color: '#ff0000' } });
      const button = element.type(element.props);
      assert.equal(button.props.pressOpacity, 1);
      assert.equal(button.props.pressColor, 'transparent');
      assert.deepEqual(button.props.style, [{ flex: 1 }, { opacity: 1 }]);
      const host = button.type.render(button.props, null);
      host.props.onPressIn({});
      host.props.onPress({ preventDefault() {}, button: 0 });
      host.props.onPressOut({});
      assert.equal(calls, 1);
      if (platform === 'android') assert.equal(host.props.android_ripple.color, 'transparent');
      else assert.ok(h.animations.every((animation: any) => animation.toValue === 1));
    });
  }
});
