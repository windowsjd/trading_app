import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ASSET_CHART_TIMEFRAMES, DEFAULT_ASSET_CHART_TIMEFRAME } from '../../features/asset/chartTimeframes.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const { createTradingUiHarness, elements } = require('../../../test/tradingUiHarness.cjs');

function setup() {
  const h = interactionHarness();
  const Backdrop = h.load('src/components/common/BottomSheetBackdrop.tsx').default;
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
      assert.deepEqual(query.queryKey, QUERY_KEYS.asset.candles(h.asset.id, {
        interval: timeframe.interval, range: timeframe.range, limit: timeframe.limit,
      }));
      assert.equal(h.liveCandleOptions.interval, timeframe.interval);
      assert.equal(elements(tree, 'CandlestickChart')[0].props.viewportResetKey, `${h.asset.id}:${timeframe.interval}`);
    }
  });

  it('opens from one localized button, selects all seven original policy objects and closes immediately', (t) => {
    const h = setup();
    t.after(() => act(() => h.renderer.unmount()));
    const trigger = () => h.button('asset-timeframe-selector');
    const modal = () => h.renderer.root.findByType('Modal');
    assert.equal(modal().props.visible, false);
    assert.equal(trigger().props.accessibilityLabel, '시간봉 선택. 현재 5분');
    const options = h.renderer.root.findAllByType('Pressable').filter((node: any) => node.props.testID?.startsWith('asset-timeframe-option-'));
    assert.deepEqual(options.map((node: any) => node.props.accessibilityLabel), ['5분', '15분', '30분', '1시간', '4시간', '1일', '1주']);
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
    assert.equal(h.selections.length, 6);
    assert.deepEqual(ASSET_CHART_TIMEFRAMES, originalPolicies, 'range/interval/limit objects are never changed');
  });

  it('uses the common interaction for the trigger and every option, while backdrop/back close without feedback', (t) => {
    const h = setup();
    t.after(() => act(() => h.renderer.unmount()));
    for (const id of ['asset-timeframe-selector', ...ASSET_CHART_TIMEFRAMES.map((item) => `asset-timeframe-option-${item.interval}`)]) {
      const button = h.button(id);
      act(() => button.props.onPressIn({ nativeEvent: { pageX: 125, pageY: 220 } }));
      assert.ok(h.renderer.root.findAllByType('AnimatedView').some((node: any) => node.props.style.width > 0));
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
      const list = h.renderer.root.findByType('ScrollView');
      assert.equal(list.props.contentContainerStyle.paddingBottom, h.insets.bottom);
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
      for (const key of ['range', 'interval', 'limit']) assert.ok(args.includes(`${key}: selectedTimeframe.${key}`));
    }
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
