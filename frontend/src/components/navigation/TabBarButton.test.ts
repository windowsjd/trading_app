import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { load, elements } = require('../../../test/ledgerTestHarness.cjs');

function harness(platform: string) {
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
  }).default;
  const dimensions = { fontScale: 1 };
  const insets = { bottom: 34 };
  const MainTabs = load(resolve('src/app/navigation/MainTabs.tsx'), {
    'react-native': { useWindowDimensions: () => dimensions },
    'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
    '@react-navigation/bottom-tabs': { createBottomTabNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
    '../../components/navigation/TabBarButton': { default: Button, __esModule: true },
    '../../components/navigation/TabBarIcon': { default: 'TabBarIcon', __esModule: true },
    ...Object.fromEntries(['Home', 'Market', 'Ranking', 'Record', 'My'].map((name) => [
      `./${name}Stack`, { default: `${name}Stack`, __esModule: true },
    ])),
  }).default;
  return { MainTabs, dimensions, insets, animations };
}

describe('bottom tab touch feedback', () => {
  for (const platform of ['android', 'ios', 'web']) {
    it(`${platform}: connects all five tabs while preserving events, icons and accessibility`, () => {
      const h = harness(platform);
      const tree = h.MainTabs();
      const screens = elements(tree, 'Screen');
      assert.deepEqual(screens.map((node: any) => node.props.name), ['HomeTab', 'MarketTab', 'RankingTab', 'RecordTab', 'MyTab']);
      for (const screen of screens) {
        for (const selected of [false, true]) {
          const icon = screen.props.options.tabBarIcon({ color: selected ? '#007aff' : '#888', size: 25 });
          assert.equal(icon.props.color, selected ? '#007aff' : '#888');
          assert.equal(icon.props.size, 25);
          const calls: string[] = [];
          const props = {
            onPress: () => calls.push('press'), onLongPress: () => calls.push('longPress'),
            onPressIn: () => calls.push('in'), onPressOut: () => calls.push('out'),
            style: [{ flex: 1, padding: 5 }], children: icon, href: `/${screen.props.name}`,
            role: platform === 'ios' ? 'button' : 'tab',
            'aria-label': screen.props.options.title, 'aria-selected': selected,
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
            assert.deepEqual(host.props.android_ripple, { color: 'rgba(0, 0, 0, 0.12)', borderless: false });
            assert.equal(h.animations.length, 0);
          } else {
            assert.equal(h.animations[0].toValue, 0.76);
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

  it('keeps the existing large-font and safe-area layout policy', () => {
    const h = harness('ios');
    assert.equal(h.MainTabs().props.screenOptions.tabBarStyle, undefined);
    h.dimensions.fontScale = 2.4;
    const options = h.MainTabs().props.screenOptions;
    assert.equal(options.tabBarLabelPosition, 'below-icon');
    assert.deepEqual(options.tabBarStyle, { height: 49 + Math.ceil(14 * 1.4) + h.insets.bottom });
  });
});
