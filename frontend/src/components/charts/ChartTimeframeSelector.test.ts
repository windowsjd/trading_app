import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ASSET_CHART_TIMEFRAMES, DEFAULT_ASSET_CHART_TIMEFRAME, resolveAssetChartTimeframe } from '../../features/asset/chartTimeframes.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const { createTradingUiHarness, elements } = require('../../../test/tradingUiHarness.cjs');

function setup() {
  const h = interactionHarness();
  const Backdrop = h.load('src/components/common/BottomSheetBackdrop.tsx', {
    'react-native-safe-area-context': { useSafeAreaInsets: () => h.insets },
  }).default;
  const Selector = h.load('src/components/charts/ChartTimeframeSelector.tsx', {
    '../common/ActionPressable': { default: h.ActionPressable, __esModule: true },
    '../common/BottomSheetBackdrop': { default: Backdrop, __esModule: true },
    'react-native-safe-area-context': { useSafeAreaInsets: () => h.insets },
  }).default;
  const selections: unknown[] = [];
  function Screen() {
    const [selectedTimeframe, setSelectedTimeframe] = React.useState(DEFAULT_ASSET_CHART_TIMEFRAME);
    return React.createElement(Selector, { selectedTimeframe, onSelect: (timeframe: unknown) => {
      selections.push(timeframe);
      setSelectedTimeframe(timeframe);
    } });
  }
  const renderer = h.render(React.createElement(Screen));
  const button = (id: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === id);
  return { ...h, renderer, selections, button, Screen };
}

const KRX_RANGES: Record<string, string> = {
  '5m': 'prev3_open', '15m': 'prev6_open', '30m': 'prev12_open', '1h': 'prev24_open', '4h': '96d', '1d': 'prev576_open',
};

describe('chart timeframe selector', () => {
  it('drives the actual detail screen candle query, live interval and viewport reset for every selection', () => {
    const h = createTradingUiHarness('asset/AssetChartScreen.tsx');
    h.candles = [{ time: '2026-09-16T00:00:00Z', open: '100', high: '102', low: '99', close: '101', volume: '20' }];
    for (const timeframe of ASSET_CHART_TIMEFRAMES) {
      const selector = elements(h.render(), 'ChartTimeframeSelector')[0];
      selector.props.onSelect(timeframe);
      const tree = h.render();
      assert.strictEqual(elements(tree, 'ChartTimeframeSelector')[0].props.selectedTimeframe, timeframe);
      const query = h.queries.find((option: any) => option.queryKey[0] === 'asset' && option.queryKey[1] === 'candles');
      // This fixture is a KRX stock: the confirmed KRX session windows and the
      // long-range 4h window (design v2.1 §5.1).
      assert.equal(h.asset.assetType, 'domestic_stock');
      const window = resolveAssetChartTimeframe(timeframe, h.asset.assetType) ?? timeframe;
      assert.equal(window.range, KRX_RANGES[timeframe.interval]);
      assert.deepEqual(query.queryKey, QUERY_KEYS.asset.candles(h.asset.id, {
        interval: window.interval, range: window.range, limit: window.limit,
      }));
      assert.equal(h.liveCandleOptions.interval, timeframe.interval);
      assert.equal(elements(tree, 'CandlestickChart')[0].props.viewportResetKey, `${h.asset.id}:${timeframe.interval}`);
    }
  });

  it('opens from one localized button, selects all six original policy objects and closes immediately', (t) => {
    const h = setup();
    t.after(() => act(() => h.renderer.unmount()));
    const trigger = () => h.button('asset-timeframe-selector');
    const modal = () => h.renderer.root.findByType('Modal');
    assert.equal(modal().props.visible, false);
    assert.equal(trigger().props.accessibilityLabel, '시간봉 선택. 현재 5분');
    const options = h.renderer.root.findAllByType('Pressable').filter((node: any) => node.props.testID?.startsWith('asset-timeframe-option-'));
    // No 1w tab (design v2.1 §5.5).
    assert.deepEqual(options.map((node: any) => node.props.accessibilityLabel), ['5분', '15분', '30분', '1시간', '4시간', '1일']);
    assert.deepEqual(options.map((node: any) => node.props.testID), ASSET_CHART_TIMEFRAMES.map((item) => `asset-timeframe-option-${item.interval}`));
    const originalPolicies = ASSET_CHART_TIMEFRAMES.map((item) => ({ ...item }));
    for (const timeframe of ASSET_CHART_TIMEFRAMES) {
      act(() => trigger().props.onPress());
      assert.equal(modal().props.visible, true);
      assert.equal(trigger().props.accessibilityState.expanded, true);
      const option = h.button(`asset-timeframe-option-${timeframe.interval}`);
      const label = option.props.accessibilityLabel;
      act(() => option.props.onPress());
      assert.equal(modal().props.visible, false);
      assert.equal(trigger().props.accessibilityLabel, `시간봉 선택. 현재 ${label}`);
      assert.equal(h.button(`asset-timeframe-option-${timeframe.interval}`).props.accessibilityState.selected, true);
      if (timeframe !== DEFAULT_ASSET_CHART_TIMEFRAME) assert.strictEqual(h.selections.at(-1), timeframe);
      const count = h.selections.length;
      act(() => trigger().props.onPress());
      act(() => h.button(`asset-timeframe-option-${timeframe.interval}`).props.onPress());
      assert.equal(h.selections.length, count, 'reselection only dismisses the list');
      assert.equal(modal().props.visible, false);
    }
    assert.equal(h.selections.length, 5);
    assert.deepEqual(ASSET_CHART_TIMEFRAMES, originalPolicies, 'range/interval/limit objects are never changed');
  });

  it('uses the common interaction for the trigger and every option, while backdrop/back close without feedback', (t) => {
    const h = setup();
    t.after(() => act(() => h.renderer.unmount()));
    for (const id of ['asset-timeframe-selector', ...ASSET_CHART_TIMEFRAMES.map((item) => `asset-timeframe-option-${item.interval}`)]) {
      const button = h.button(id);
      // The common ink: a hidden layer inside the button, inked from the touch.
      const layer = button.findAll((node: any) => node.type === 'View' && node.props.accessibilityElementsHidden === true && typeof node.props.onLayout === 'function')[0];
      act(() => layer.props.onLayout({ nativeEvent: { layout: { width: 120, height: 44 } } }));
      act(() => button.props.onPressIn({ nativeEvent: { pageX: 125, pageY: 220, locationX: 20, locationY: 10 } }));
      assert.equal(flatten(h.button(id).findAll((node: any) => node.type === 'View' && typeof node.props.onLayout === 'function')[0]
        .findAllByType('AnimatedView')[0].props.style).opacity.value.value, 1);
      act(() => button.props.onPressOut({ nativeEvent: {} }));
      h.finish();
    }
    const open = () => act(() => h.button('asset-timeframe-selector').props.onPress());
    open();
    act(() => h.renderer.root.findByType('Modal').props.onRequestClose());
    assert.equal(h.renderer.root.findByType('Modal').props.visible, false);
    open();
    const backdrop = h.renderer.root.findAllByType('Pressable').find((node: any) => !node.props.testID);
    assert.deepEqual(backdrop.props.style, { flex: 1 });
    act(() => backdrop.props.onPress());
    assert.equal(h.renderer.root.findByType('Modal').props.visible, false);
    open();
    act(() => h.button('asset-timeframe-close').props.onPress());
    assert.equal(h.renderer.root.findByType('Modal').props.visible, false);
    assert.equal(h.selections.length, 0);
  });

  it('keeps labels unrestricted and the list scrollable within a small safe-area viewport', (t) => {
    const h = setup();
    t.after(() => act(() => h.renderer.unmount()));
    for (const height of [568, 320]) {
      h.dimensions.height = height;
      act(() => h.renderer.update(React.createElement(h.Screen)));
      const content = h.renderer.root.findAllByType('View').find((node: any) => node.props.accessibilityViewIsModal);
      assert.ok(flatten(content.props.style).maxHeight + h.insets.top + 40 <= height);
      // The bottom inset is applied once, by the backdrop's sheet (the Modal is edge to edge
      // on Android); the list adds none, and the whole sheet still ends below the status bar.
      const sheet = flatten(content.parent.props.style);
      assert.equal(sheet.paddingBottom, Math.max(h.insets.bottom, 12) + 8);
      const list = h.renderer.root.findByType('ScrollView');
      assert.equal(list.props.contentContainerStyle?.paddingBottom === undefined, true, 'no second inset in the list');
      assert.ok(h.insets.top + sheet.padding + flatten(content.props.style).maxHeight + sheet.paddingBottom <= height);
      assert.ok(list.findAllByType('Text').some((text: any) => text.props.children === '시간봉'), 'the header can also scroll at extreme font sizes');
      for (const text of h.renderer.root.findAllByType('Text')) {
        assert.equal(text.props.numberOfLines, undefined);
        assert.notEqual(text.props.allowFontScaling, false);
        assert.equal(flatten(text.props.style).height, undefined);
      }
      assert.equal(flatten(h.button('asset-timeframe-selector').props.style).maxWidth, '100%');
    }
  });

  it('keeps candle query/live-candle/viewport bindings and leaves the bottom tabs outside this policy', () => {
    const screen = readFileSync(resolve('src/screens/asset/AssetChartScreen.tsx'), 'utf8');
    assert.match(screen, /<ChartTimeframeSelector\s+selectedTimeframe=\{selectedTimeframe\}\s+onSelect=\{setSelectedTimeframe\}/);
    for (const call of ['QUERY_KEYS.asset.candles', 'getAssetCandles']) {
      const start = screen.indexOf(`${call}(assetId, {`);
      assert.ok(start > 0);
      const args = screen.slice(start, screen.indexOf('}', start));
      for (const key of ['range', 'interval', 'limit']) assert.ok(args.includes(`${key}: chartWindow.${key}`));
    }
    // The request window is the selected tab resolved per market (4h only).
    assert.match(screen, /resolveAssetChartTimeframe\(\s+selectedTimeframe,\s+detailQuery\.data\?\.asset\?\.assetType,/);
    assert.match(screen, /useAssetCandle\(\{\s+assetId,\s+interval: selectedTimeframe.interval/);
    assert.ok(screen.includes('mergeAssetCandleSnapshot('));
    assert.ok(screen.includes('viewportResetKey={`${assetId}:${selectedTimeframe.interval}`}'));
    assert.ok(screen.includes('candleResyncVersion > 0'));
    assert.ok(screen.includes('isCandleStale'));
    assert.doesNotMatch(screen, /ASSET_CHART_TIMEFRAMES.map/);
    for (const file of ['src/app/navigation/MainTabs.tsx', 'src/components/navigation/TabBarButton.tsx']) {
      assert.doesNotMatch(readFileSync(resolve(file), 'utf8'), /ActionPressable|pressFeedback|ChartTimeframeSelector/);
    }
  });
});
