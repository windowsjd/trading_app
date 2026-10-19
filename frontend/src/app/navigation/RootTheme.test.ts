import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const { load, elements } = createRequire(import.meta.url)('../../../test/ledgerTestHarness.cjs');

for (const mode of ['light', 'dark'] as const) {
  test(`NavigationContainer and root stack use the ${mode} appearance`, () => {
    const colors = mode === 'dark'
      ? { screen: '#15171c', surface: '#1c1d21', text: '#f2f5f7', border: '#3b3d43' }
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
      '../../features/order/OrderFillNotifier': { default: 'OrderFillNotifier', __esModule: true },
      '../../features/notifications/PushNotificationsHost': { default: 'PushNotificationsHost', __esModule: true },
    };
    for (const name of ['./AuthStack', './MainTabs', '../../screens/auth/SplashScreen',
      '../../screens/history/TradeHistoryScreen', '../../screens/history/OrderFailureScreen', '../../screens/asset/AssetChartScreen', '../../screens/futures/FuturesChartScreen', '../../screens/entry/ModeSelectionScreen', '../../screens/season/SeasonJoinScreen']) {
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
    // The fill banner sits beside the root stack, inside navigation, so it
    // overlays every tab and pushed screen and can open TradeHistory.
    assert.equal(elements(tree, 'OrderFillNotifier').length, 1);
    // Push permission/registration/tap routing also lives inside navigation,
    // mounted once for every route (sign-in included).
    assert.equal(elements(tree, 'PushNotificationsHost').length, 1);
    // Both full-screen charts (spot AssetChart, the futures contract's FuturesChart) open the same way.
    for (const name of ['AssetChart', 'FuturesChart']) {
      const chart = screens.find((s: any) => s.props.name === name);
      assert.equal(chart.props.component, `../../screens/${name === 'AssetChart' ? 'asset' : 'futures'}/${name}Screen`);
      assert.equal(chart.props.options.presentation, 'fullScreenModal', name);
      assert.equal(chart.props.options.animation, 'fade', name);
    }
  });
}
