import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChartHarness, elements } from './chartIntegrationHarness.cjs';
import { chartLabelWidth } from './candlestickLayout.ts';
import { formatChartPrice } from './candlestickPriceFormat.ts';
import { formatKstDateTime } from '../../utils/format.ts';

// RNGH State values. Inputs below are Android native state transitions, sent
// through the installed eventReceiver, NOT direct calls to policy functions.
const UNDETERMINED = 0, FAILED = 1, BEGAN = 2, CANCELLED = 3, ACTIVE = 4, END = 5;
const candles = Array.from({ length: 240 }, (_, i) => ({
  time: new Date(Date.UTC(2026, 8, 1, 0, i * 5)).toISOString(),
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i,
}));

function setup(extra = {}) {
  const harness = createChartHarness();
  const chart = harness.component('CandlestickChart.tsx', {
    candles, currencyCode: 'USD', displayPriceDecimals: 5, viewportResetKey: '5m', ...extra,
  });
  chart.render();
  chart.flushEffects();
  const chartTree = chart.render();
  const adapterElement = elements(chartTree).find((element) => element.props.onPan);
  const intents: string[] = [];
  const adapter = harness.component('CandlestickGestures.native.tsx', {
    ...adapterElement.props,
    onGestureStart: () => { intents.push('start'); adapterElement.props.onGestureStart(); },
    onGestureEnd: () => { intents.push('end'); adapterElement.props.onGestureEnd(); },
  });
  const detector = adapter.render();
  adapter.flushEffects();
  const events = harness.attach(detector.props.gesture);
  const pinch = events.handlers.find((handler) => handler.handlerName === 'PinchGestureHandler')!;
  const pan = events.handlers.find((handler) => handler.config.activeOffsetXEnd)!;
  const crosshair = events.handlers.find((handler) => handler.config.activateAfterLongPress || handler.handlerName === 'LongPressGestureHandler')!;
  const geometry = () => elements(chart.render()).find((element) => element.props.geometry)!.props;
  const renderer = () => harness.component('CandlestickChartRenderer.tsx', geometry()).render();
  const down = () => events.handlers.forEach((handler) => events.state(handler, UNDETERMINED, BEGAN));
  return { harness, chart, adapter, detector, events, pinch, pan, crosshair, intents, geometry, renderer, down };
}

describe('native adapter → RNGH JS event receiver → chart state → shared renderer', () => {
  it('Android first-finger pinch BEGAN does not claim a chart session', () => {
    const h = setup();
    h.down();
    assert.deepEqual(h.intents, []);
    assert.equal(h.geometry().crosshair, null);
  });

  it('one finger pans to history, reverses, clamps both loaded edges and resets to latest', () => {
    const h = setup();
    const latest = h.geometry().geometry.startIndex;
    h.down();
    h.events.state(h.pan, BEGAN, ACTIVE, { translationX: 0 });
    h.events.update(h.pan, { translationX: 50 });
    const history = h.geometry().geometry.startIndex;
    assert.ok(history < latest);
    h.events.update(h.pan, { translationX: 25 });
    assert.ok(h.geometry().geometry.startIndex > history);
    h.events.update(h.pan, { translationX: 100_000 });
    assert.equal(h.geometry().geometry.startIndex, 0);
    h.events.update(h.pan, { translationX: -100_000 });
    assert.equal(h.geometry().geometry.startIndex, latest);
    h.events.update(h.pan, { translationX: 50 });
    h.events.state(h.pan, ACTIVE, END);
    h.events.state(h.pinch, BEGAN, FAILED);
    h.events.state(h.crosshair, BEGAN, FAILED);
    assert.deepEqual(h.intents, ['start', 'end']);
    const reset = elements(h.chart.render(), 'Pressable')[0];
    assert.equal(reset.props.children.props.children, '최신');
    reset.props.onPress();
    assert.equal(h.geometry().geometry.startIndex, latest);
    assert.equal(elements(h.chart.render(), 'Pressable').length, 0);
  });

  it('a stationary long hold displays both labels, then scrubs far beyond the old 10px limit', () => {
    const h = setup();
    h.down();
    h.events.state(h.crosshair, BEGAN, ACTIVE, { x: 90, y: 80 });
    h.events.state(h.pan, BEGAN, CANCELLED);
    const initial = h.geometry().crosshair;
    assert.ok(initial);
    const labels = elements(h.renderer(), 'text').map((element) => element.props.children);
    assert.equal(labels.at(-1), formatKstDateTime(new Date(candles[initial.index].time)));
    const g = h.geometry().geometry;
    const expectedPrice = g.minY + (1 - (80 - g.padding.top) / g.innerHeight) * g.range;
    assert.equal(labels.at(-2), formatChartPrice(expectedPrice, 'USD', 5));
    h.events.update(h.crosshair, { x: 180, y: 220 });
    assert.ok(h.geometry().crosshair.index > initial.index);
    assert.equal(h.geometry().crosshair.y, 220);
    const lines = elements(h.renderer(), 'line').filter((element) => element.props.strokeDasharray === '2 2');
    assert.equal(lines.length, 2);
    assert.equal(lines[1].props.y1, 220);
    h.events.state(h.crosshair, ACTIVE, END);
    h.events.state(h.pinch, BEGAN, FAILED);
    assert.equal(h.geometry().crosshair, null);
    assert.deepEqual(h.intents, ['start', 'end']);
  });

  for (const terminal of [END, CANCELLED, FAILED]) {
    it(`clears a held crosshair on terminal state ${terminal}, including a hold without movement`, () => {
      const h = setup();
      h.down();
      h.events.state(h.crosshair, BEGAN, ACTIVE);
      h.events.state(h.crosshair, ACTIVE, terminal);
      h.events.state(h.pinch, BEGAN, FAILED);
      assert.equal(h.geometry().crosshair, null);
      assert.deepEqual(h.intents, ['start', 'end']);
    });
  }

  it('leaving any chart edge clears crosshair and reentry cannot revive it', () => {
    for (const point of [{ x: -1, y: 100 }, { x: 321, y: 100 }, { x: 100, y: -1 }, { x: 100, y: 900 }]) {
      const h = setup();
      h.down();
      h.events.state(h.crosshair, BEGAN, ACTIVE);
      h.events.update(h.crosshair, point);
      assert.equal(h.geometry().crosshair, null);
      h.events.update(h.crosshair, { x: 100, y: 100 });
      h.events.state(h.crosshair, ACTIVE, CANCELLED);
      assert.equal(h.geometry().crosshair, null);
      assert.deepEqual(h.intents, ['start', 'end']);
    }
  });

  it('pinch activates after a hold, clears crosshair, zooms both ways and ignores late finalizers', () => {
    const h = setup();
    h.down();
    h.events.state(h.crosshair, BEGAN, ACTIVE);
    const initialWidth = h.geometry().geometry.slotWidth;
    h.events.state(h.pinch, BEGAN, ACTIVE, { numberOfPointers: 2 });
    h.events.state(h.crosshair, ACTIVE, CANCELLED);
    assert.equal(h.geometry().crosshair, null);
    h.events.update(h.pinch, { scale: 2, focalX: 200, numberOfPointers: 2 });
    assert.ok(h.geometry().geometry.slotWidth > initialWidth);
    h.events.update(h.pinch, { scale: 0.5, focalX: 200, numberOfPointers: 2 });
    assert.ok(h.geometry().geometry.slotWidth < initialWidth);
    h.events.state(h.pinch, ACTIVE, END);
    h.events.state(h.pan, BEGAN, FAILED);
    assert.deepEqual(h.intents, ['start', 'end', 'start', 'end']);
  });

  it('native configuration races horizontal pan vs hold, while pinch can take over either', () => {
    const h = setup();
    assert.equal(h.crosshair.config.activateAfterLongPress, 300);
    assert.equal(h.crosshair.config.shouldCancelWhenOutside, true);
    assert.equal(h.crosshair.config.manualActivation, undefined);
    assert.equal(h.pan.config.activeOffsetXStart, -10);
    assert.equal(h.pan.config.activeOffsetXEnd, 10);
    assert.equal(h.pan.config.failOffsetYStart, -10);
    assert.equal(h.pan.config.failOffsetYEnd, 10);
    assert.equal(h.pan.config.maxPointers, 1);
    assert.equal(h.crosshair.config.maxPointers, 1);
    assert.ok(!h.pan.config.simultaneousWith.includes(h.crosshair));
    assert.ok(h.pan.config.simultaneousWith.includes(h.pinch));
    assert.ok(h.crosshair.config.simultaneousWith.includes(h.pinch));
    assert.ok(h.events.handlers.every((handler) => !handler.shouldUseReanimated));
    assert.equal(h.detector.props.children.props.collapsable, false);
  });

  it('a fresh pinch and a pan-to-pinch transition use distinct viewport snapshots', () => {
    for (const withPan of [false, true]) {
      const h = setup();
      h.down();
      if (withPan) {
        h.events.state(h.pan, BEGAN, ACTIVE);
        h.events.update(h.pan, { translationX: 80 });
        assert.ok(h.geometry().geometry.startIndex < 180);
      }
      const before = h.geometry().geometry;
      h.events.state(h.pinch, BEGAN, ACTIVE, { numberOfPointers: 2 });
      h.events.state(h.pan, withPan ? ACTIVE : BEGAN, CANCELLED);
      h.events.state(h.crosshair, BEGAN, FAILED);
      h.events.update(h.pinch, { scale: 2, focalX: before.padding.left + before.innerWidth, numberOfPointers: 2 });
      const after = h.geometry().geometry;
      assert.equal(after.slotWidth, before.slotWidth * 2);
      assert.equal(after.startIndex, before.startIndex + 30);
      h.events.state(h.pinch, ACTIVE, END);
      assert.deepEqual(h.intents, withPan ? ['start', 'end', 'start', 'end'] : ['start', 'end']);
    }
  });

  it('separate pan sessions preserve their origin and ignore non-owner finalizers', () => {
    const h = setup();
    h.down();
    h.events.state(h.pan, BEGAN, ACTIVE, { translationX: 12 });
    h.events.update(h.pan, { translationX: 72 });
    const history = h.geometry().geometry.startIndex;
    h.events.state(h.pan, ACTIVE, END);
    h.events.state(h.pinch, BEGAN, FAILED);
    h.events.state(h.crosshair, BEGAN, FAILED);
    h.down();
    h.events.state(h.pan, BEGAN, ACTIVE, { translationX: -12 });
    h.events.update(h.pan, { translationX: -42 });
    assert.ok(h.geometry().geometry.startIndex > history);
    h.events.state(h.crosshair, BEGAN, FAILED);
    h.events.update(h.pan, { translationX: -72 });
    assert.equal(h.geometry().geometry.startIndex, 180);
    h.events.state(h.pan, ACTIVE, END);
    assert.deepEqual(h.intents, ['start', 'end', 'start', 'end']);
  });

  it('a native vertical-swipe cancellation leaves chart state untouched and no session open', () => {
    const h = setup();
    const initial = h.geometry().geometry.startIndex;
    h.down();
    h.events.handlers.forEach((handler) => h.events.state(handler, BEGAN, CANCELLED));
    assert.equal(h.geometry().geometry.startIndex, initial);
    assert.equal(h.geometry().crosshair, null);
    assert.deepEqual(h.intents, []);
  });

  it('timeframe resets chart and adapter identity; teardown closes an active hold once', () => {
    const h = setup();
    h.down();
    h.events.state(h.crosshair, BEGAN, ACTIVE);
    h.adapter.unmount();
    h.chart.props.viewportResetKey = '1h';
    h.chart.render();
    h.chart.flushEffects();
    assert.equal(h.geometry().crosshair, null);
    assert.equal(h.geometry().geometry.startIndex, 180);
    assert.equal(elements(h.chart.render()).find((element) => element.props.onPan)!.key, '1h');
    assert.deepEqual(h.intents, ['start', 'end']);
  });

  it('rotation closes the old session and the new recognizers can pan', () => {
    const h = setup();
    h.down();
    h.events.state(h.crosshair, BEGAN, ACTIVE);
    h.adapter.props = { ...h.adapter.props, chartWidth: 700, chartHeight: 320 };
    const rotated = h.adapter.render();
    h.adapter.flushEffects();
    assert.equal(h.geometry().crosshair, null);
    const next = h.harness.attach(rotated.props.gesture);
    const pan = next.handlers.find((handler) => handler.config.activeOffsetXEnd)!;
    next.state(pan, UNDETERMINED, BEGAN);
    next.state(pan, BEGAN, ACTIVE);
    next.update(pan, { translationX: 50 });
    assert.ok(h.geometry().geometry.startIndex < 180);
    next.state(pan, ACTIVE, END);
    assert.deepEqual(h.intents, ['start', 'end', 'start', 'end']);
  });

  it('history excludes the live price from Y bounds without resizing the plot mid-pan', () => {
    const h = setup({ currentPrice: 1_000_000 });
    const latest = h.geometry().geometry;
    assert.ok(latest.maxY > 1_000_000);
    h.down();
    h.events.state(h.pan, BEGAN, ACTIVE);
    h.events.update(h.pan, { translationX: 80 });
    const history = h.geometry();
    assert.ok(history.geometry.maxY < 500);
    assert.equal(history.currentPrice, null);
    assert.equal(history.geometry.innerWidth, latest.innerWidth);
  });

  it('short datasets stay aligned to the right and crosshair selects existing candles', () => {
    const h = setup({ candles: candles.slice(0, 12) });
    assert.equal(h.geometry().geometry.leadingEmptySlots, 48);
    h.down();
    h.events.state(h.crosshair, BEGAN, ACTIVE, { x: 0, y: 100 });
    assert.equal(h.geometry().crosshair.index, 0);
    h.events.update(h.crosshair, { x: 320, y: 100 });
    assert.equal(h.geometry().crosshair.index, 11);
  });

  it('fits price/time labels within small portrait and landscape chart boxes at 8 decimals', () => {
    for (const width of [254, 294, 650]) {
      for (const currencyCode of ['USD', 'KRW']) {
        const h = setup({
          candles: candles.map((candle) => ({ ...candle, open: 123456789.12345678, high: 123456790.12345678, low: 123456788.12345678, close: 123456789.98765432 })),
          currencyCode, displayPriceDecimals: 8,
        });
        const container = elements(h.chart.render()).find((element) => element.props.onLayout)!;
        container.props.onLayout({ nativeEvent: { layout: { width } } });
        if (width > 600) Object.assign(h.harness.dimensions, { width: 800, height: 360 });
        const geometry = h.geometry().geometry;
        assert.equal(geometry.width, width);
        const times = elements(h.renderer(), 'text').filter((node) => /^2026-/.test(node.props.children));
        if (times.length === 2) {
          const firstRight = times[0].props.x + chartLabelWidth(times[0].props.children);
          const lastLeft = times[1].props.x - chartLabelWidth(times[1].props.children);
          assert.ok(firstRight < lastLeft, 'static timestamps must not overlap');
        } else {
          assert.equal(times.length, 1, 'narrow charts retain the latest visible timestamp');
        }
        h.down();
        h.events.state(h.crosshair, BEGAN, ACTIVE, { x: 250, y: 350 });
        for (const node of elements(h.renderer(), 'text')) {
          const labelWidth = chartLabelWidth(node.props.children, node.props.fontSize);
          const left = node.props.x - (node.props.textAnchor === 'middle' ? labelWidth / 2 : node.props.textAnchor === 'end' ? labelWidth : 0);
          assert.ok(left >= 0 && left + labelWidth <= width + 0.01);
          assert.ok(node.props.y < geometry.height);
        }
        for (const node of elements(h.renderer(), 'rect').filter((node) => node.props.fill === '#64748b')) {
          assert.ok(node.props.x >= 0 && node.props.x + node.props.width <= width + 0.01);
          assert.ok(node.props.y >= 0 && node.props.y + node.props.height <= geometry.height);
        }
      }
    }
  });
});
