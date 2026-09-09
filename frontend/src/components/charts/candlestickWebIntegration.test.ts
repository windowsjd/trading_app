import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChartHarness, elements } from './chartIntegrationHarness.cjs';

function setup() {
  const harness = createChartHarness('web');
  const chart = harness.component('CandlestickChart.tsx', {
    candles: Array.from({ length: 240 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 8, 1, 0, i * 5)).toISOString(),
      open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i,
    })),
    currencyCode: 'USD',
  });
  chart.render();
  chart.flushEffects();
  const props = elements(chart.render()).find((element) => element.props.onPan)!.props;
  const adapter = harness.component('CandlestickGestures.web.tsx', props);
  const listeners = new Map();
  let wheelOptions;
  const node = {
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    addEventListener: (name, fn, options) => { listeners.set(name, fn); if (name === 'wheel') wheelOptions = options; },
    removeEventListener: (name) => listeners.delete(name),
  };
  adapter.render().props.ref.current = node;
  adapter.flushEffects();
  const geometry = () => elements(chart.render()).find((element) => element.props.geometry)!.props;
  let prevented = 0;
  const fire = (name, fields = {}) => listeners.get(name)({
    button: 0, clientX: 100, clientY: 130, deltaX: 0, deltaY: 0,
    preventDefault: () => { prevented += 1; }, ...fields,
  });
  return { harness, chart, adapter, listeners, geometry, fire, wheelOptions, prevented: () => prevented };
}

describe('existing web adapter → chart state integration', () => {
  it('mouse hover, drag, outside mouseup and latest reset retain their behavior', () => {
    const h = setup();
    h.fire('mousemove');
    assert.equal(h.geometry().crosshair.y, 100);
    h.fire('mousedown');
    assert.equal(h.geometry().crosshair, null);
    h.fire('mousemove', { clientX: 150 });
    assert.ok(h.geometry().geometry.startIndex < 180);
    h.harness.windowEvents.get('mouseup')!();
    h.fire('mousemove');
    assert.ok(h.geometry().crosshair);
    h.fire('mouseleave');
    assert.equal(h.geometry().crosshair, null);
    elements(h.chart.render(), 'Pressable')[0].props.onPress();
    assert.equal(h.geometry().geometry.startIndex, 180);
    h.adapter.unmount();
    assert.equal(h.listeners.size, 0);
    assert.equal(h.harness.windowEvents.size, 0);
  });

  it('wheel and Ctrl/Cmd trackpad pinch accumulate zoom; wheels during drag are consumed', () => {
    const h = setup();
    assert.deepEqual(h.wheelOptions, { passive: false });
    const initial = h.geometry().geometry.slotWidth;
    h.fire('wheel', { deltaY: -120 });
    const first = h.geometry().geometry.slotWidth;
    assert.ok(first > initial);
    h.fire('wheel', { deltaY: -120, ctrlKey: true });
    assert.ok(h.geometry().geometry.slotWidth > first);
    h.fire('wheel', { deltaY: -120, metaKey: true });
    h.fire('mousedown');
    const dragStart = h.geometry().geometry;
    h.fire('wheel', { deltaY: 120 });
    h.fire('wheel', { deltaX: 80 });
    assert.equal(h.geometry().geometry, dragStart);
    assert.equal(h.prevented(), 5);
    h.adapter.unmount();
  });

  it('horizontal trackpad and Shift+wheel pan and reverse inside loaded data', () => {
    const h = setup();
    h.fire('wheel', { deltaX: -60, deltaY: 2 });
    const first = h.geometry().geometry.startIndex;
    assert.ok(first < 180);
    h.fire('wheel', { deltaY: -60, shiftKey: true });
    assert.ok(h.geometry().geometry.startIndex < first);
    h.fire('wheel', { deltaX: 120 });
    assert.equal(h.geometry().geometry.startIndex, 180);
    h.adapter.unmount();
  });
});
