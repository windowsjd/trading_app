import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const { load, elements } = createRequire(import.meta.url)('../../../test/ledgerTestHarness.cjs');

for (const mode of ['light', 'dark'] as const) {
  test(`NavigationContainer and root stack use the ${mode} appearance`, () => {
    const colors = mode === 'dark'
      ? { screen: '#15171c', surface: '#1b2530', text: '#f2f5f7', border: '#435364' }
      : { screen: '#fcfcfd', surface: '#ffffff', text: '#202a35', border: '#e5e8eb' };
    const mocks: Record<string, unknown> = {
      'react-native': { Platform: { OS: 'ios' } },
      '@react-navigation/native': {
        NavigationContainer: 'NavigationContainer',
        DefaultTheme: { dark: false, colors: { background: '#fff' } },
        DarkTheme: { dark: true, colors: { background: '#000' } },
      },
      '@react-navigation/native-stack': { createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
      '../../theme/appearance': { useAppearance: () => ({ mode, colors }) },
      '../../theme/useReducedMotion': { useReducedMotion: () => false },
      './navigationRef': { rootNavigationRef: {} },
      '../../components/states/ScreenErrorBoundary': { default: 'ScreenErrorBoundary', __esModule: true },
    };
    for (const name of ['./AuthStack', './MainTabs', '../../screens/auth/SplashScreen',
      '../../screens/history/TradeHistoryScreen', '../../screens/asset/AssetChartScreen', '../../screens/entry/ModeSelectionScreen', '../../screens/season/SeasonJoinScreen']) {
      mocks[name] = { default: name, __esModule: true };
    }
    const Root = load(resolve('src/app/navigation/RootNavigator.tsx'), mocks).default;
    const tree = Root();
    assert.equal(tree.props.theme.dark, mode === 'dark');
    assert.equal(tree.props.theme.colors.background, colors.screen);
    assert.equal(tree.props.theme.colors.card, colors.surface);
    assert.equal(tree.props.theme.colors.text, colors.text);
    assert.equal(tree.props.theme.colors.border, colors.border);
    const stack = elements(tree, 'Navigator')[0];
    assert.equal(stack.props.screenOptions.contentStyle.backgroundColor, colors.screen);
    const screens = elements(tree, 'Screen');
    for (const name of ['TradeHistory', 'SeasonJoin']) {
      assert.equal(screens.find((s: any) => s.props.name === name).props.options.animation, 'simple_push');
    }
    const chart = screens.find((s: any) => s.props.name === 'AssetChart');
    assert.equal(chart.props.options.presentation, 'fullScreenModal');
    assert.equal(chart.props.options.animation, 'fade');
  });
}
