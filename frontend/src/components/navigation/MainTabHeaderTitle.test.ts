import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const { elements, load } = createRequire(import.meta.url)('../../../test/ledgerTestHarness.cjs');
const native = { View: 'View', Platform: { OS: 'ios' }, StyleSheet: { create: styles => styles } };
const navigationTheme = { useTheme: () => ({ fonts: { heavy: { fontFamily: 'System', fontWeight: '700' } } }) };

for (const [stack, root, label, icon] of [
  ['Home', 'Home', '홈', 'home'], ['Market', 'Market', '마켓', 'market'],
  ['Guide', 'Guide', '가이드', 'guide'], ['Ranking', 'Ranking', '랭킹', 'ranking'],
  ['Wallet', 'Wallet', '지갑', 'wallet'], ['My', 'Overall', '전체', 'menu'],
]) {
  test(`${stack}: only the root title reuses its tab icon; detail headers and transitions stay native`, () => {
    const file = resolve(`src/app/navigation/${stack}Stack.tsx`);
    const mocks = {
      'react-native': native,
      '@react-navigation/native-stack': { createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
      '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
      '@react-navigation/native': navigationTheme,
      'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
      '../../theme/useReducedMotion': { useReducedMotion: () => true },
      './RecordStack': { default: 'RecordStack', __esModule: true },
      ...Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/import (\w+) from '(\.\.\/\.\.\/screens\/[^']+)'/g)]
        .map(match => [match[2], { default: match[1], __esModule: true }])),
    };
    const tree = load(file, mocks).default();
    assert.deepEqual(tree.props.screenOptions, { animation: 'none' });
    const screens = elements(tree, 'Screen');
    const first = screens.find(screen => screen.props.name === root);
    assert.equal(first.props.options.title, label);
    const title = first.props.options.headerTitle({ children: label, tintColor: '#f2f5f7' });
    assert.equal(title.props.icon, icon);
    assert.equal(title.props.children, label);
    assert.equal(title.props.tintColor, '#f2f5f7');
    for (const screen of screens) {
      assert.equal(screen.props.options.header, undefined);
      assert.equal(screen.props.options.headerLeft, undefined);
      assert.equal(screen.props.options.headerBackVisible, undefined);
      if (screen !== first) {
        assert.equal(screen.props.options.headerTitle, undefined, screen.props.name);
        assert.equal(screen.props.options.headerTitleStyle, undefined, screen.props.name);
      }
    }
  });
}

test('the root title keeps Navigation heading semantics, platform size, tint, and layout measurement', () => {
  const Title = load(resolve('src/components/navigation/MainTabHeaderTitle.tsx'), {
    'react-native': native,
    '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
    '@react-navigation/native': navigationTheme,
    './TabBarIcon': { default: 'TabBarIcon', __esModule: true },
  }).default;
  const onLayout = () => {};
  const row = Title({ icon: 'home', children: '홈', tintColor: '#f2f5f7', onLayout, allowFontScaling: true });
  assert.equal(row.props.onLayout, onLayout, 'measure the icon and text together');
  const text = elements(row, 'HeaderTitle')[0];
  assert.equal(text.props.children, '홈');
  assert.equal(text.props.tintColor, '#f2f5f7');
  assert.equal(text.props.allowFontScaling, true);
  assert.equal(text.props.maxFontSizeMultiplier, 2);
  assert.equal(text.props.onLayout, undefined, 'text measurements must not overwrite row measurements');
  const style = Object.assign({}, ...text.props.style.filter(Boolean));
  assert.equal(style.fontWeight, '700');
  assert.equal(style.fontSize, undefined);
  assert.equal(style.lineHeight, undefined);
  assert.equal(style.height, undefined);
  const svg = elements(row, 'TabBarIcon')[0];
  assert.equal(svg.props.name, 'home');
  assert.equal(svg.props.size, 20);
  assert.equal(svg.props.color, '#f2f5f7', 'the home header follows the title tint');
  assert.equal(svg.props.focused, true, 'the header uses the filled home silhouette');
  assert.equal(row.props.accessible, undefined, 'only HeaderTitle announces the heading');
});

test('header icons follow the navigation tint in both themes', () => {
  for (const mode of ['light', 'dark']) {
    const text = mode === 'light' ? '#202a35' : '#f2f5f7';
    const Title = load(resolve('src/components/navigation/MainTabHeaderTitle.tsx'), {
      'react-native': native,
      '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
      '@react-navigation/native': navigationTheme,
      '../../theme/appearance': { useAppearance: () => ({ mode, colors: { text } }) },
      './TabBarIcon': { default: 'TabBarIcon', __esModule: true },
    }).default;
    for (const icon of ['home', 'market', 'guide', 'ranking', 'wallet', 'menu']) {
      for (const tintColor of [undefined, '#ffffff']) {
        const tree = Title({ icon, children: '제목', tintColor });
        const svg = elements(tree, 'TabBarIcon')[0];
        assert.equal(svg.props.color, tintColor ?? text);
        assert.equal(svg.props.focused, icon === 'home');
      }
    }
  }
});

test('home shares one undecorated contour in outline and filled states at tab/header sizes', () => {
  const Icon = load(resolve('src/components/navigation/TabBarIcon.tsx'), {
    'react-native': native,
    'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
  }).default;
  for (const size of [18, 20, 24]) {
    const outline = Icon({ name: 'home', color: '#111111', size });
    const filled = Icon({ name: 'home', color: '#326FE5', size, focused: true });
    const outlinePaths = elements(outline, 'Path');
    const filledPaths = elements(filled, 'Path');
    assert.equal(outlinePaths.length, 1, 'the doorway belongs to the house perimeter');
    assert.equal(filledPaths.length, 1, 'no added outline or internal decoration');
    assert.equal(filledPaths[0].props.d, outlinePaths[0].props.d);
    assert.ok(outlinePaths[0].props.strokeWidth > 2, 'slightly heavier than the other tab outlines');
    for (const [tree, fill, stroke] of [[outline, 'none', '#111111'], [filled, '#326FE5', 'none']]) {
      const svg = elements(tree, 'Svg')[0];
      assert.equal(svg.props.width, size);
      assert.equal(svg.props.height, size);
      assert.equal(svg.props.viewBox, '0 0 24 24');
      assert.equal(svg.props.fill, fill);
      assert.equal(svg.props.stroke, stroke);
      assert.equal(elements(tree, 'Circle').length, 0);
    }
    assert.equal(outline.props['aria-hidden'], true);
    assert.equal(filled.props.importantForAccessibility, 'no-hide-descendants');
  }
});
