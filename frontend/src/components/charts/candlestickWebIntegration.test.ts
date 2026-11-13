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
    style: {} as { userSelect?: string; touchAction?: string },
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    addEventListener: (name, fn, options) => { listeners.set(name, fn); if (name === 'wheel') wheelOptions = options; },
    removeEventListener: (name) => listeners.delete(name),
  };
  adapter.render().props.ref.current = node;
  adapter.flushEffects();
  const geometry = () => elements(chart.render()).find((element) => element.props.geometry)!.props;
  let prevented = 0;
  const fire = (name, fields = {}) => (listeners.get(name) ?? harness.windowEvents.get(name))({
    type: name, button: 0, buttons: name === 'pointerdown' ? 1 : 0, pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 130, deltaX: 0, deltaY: 0,
    preventDefault: () => { prevented += 1; }, ...fields,
  });
  return { harness, chart, adapter, listeners, node, geometry, fire, wheelOptions, prevented: () => prevented };
}

describe('existing web adapter → chart state integration', () => {
  it('mouse hover follows; a press alone changes nothing; a drag hides it and moves the chart; outside release and 최신 still work', () => {
    const h = setup();
    h.fire('pointermove');
    assert.ok(Math.abs(h.geometry().crosshair.y - 100) < 1e-9);
    h.fire('pointerdown');
    assert.ok(h.geometry().crosshair, 'pressing is not yet a drag');
    // 3 px is still a press (a click), not a move.
    h.harness.windowEvents.get('pointermove')!({ pointerId: 1, buttons: 1, clientX: 103, clientY: 130, preventDefault() {} });
    assert.equal(h.geometry().geometry.startIndex, 180);
    h.harness.windowEvents.get('pointermove')!({ pointerId: 1, buttons: 1, clientX: 150, clientY: 130, preventDefault() {} });
    assert.equal(h.geometry().crosshair, null, 'a drag hides the hovering crosshair');
    assert.ok(h.geometry().geometry.startIndex < 180);
    h.harness.windowEvents.get('pointerup')!({ pointerId: 1, type: 'pointerup' });
    h.fire('pointermove');
    assert.ok(h.geometry().crosshair);
    h.fire('pointerleave');
    assert.equal(h.geometry().crosshair, null);
    elements(h.chart.render(), 'Pressable')[0].props.onPress();
    assert.equal(h.geometry().geometry.startIndex, 180);
    assert.equal(h.node.style.touchAction, 'none', 'touch drags on the chart move the chart, not the page');
    h.adapter.unmount();
    assert.equal(h.listeners.size, 0);
    assert.equal(h.harness.windowEvents.size, 0);
    assert.equal(h.node.style.touchAction, undefined, 'restored on unmount');
  });

  it('a click pins the crosshair; hover and leaving keep it; the next click clears it', () => {
    const h = setup();
    const click = (clientX: number, clientY: number, jitter = 0) => {
      h.fire('pointerdown', { clientX, clientY });
      if (jitter) h.harness.windowEvents.get('pointermove')!({ pointerId: 1, buttons: 1, clientX: clientX + jitter, clientY, preventDefault() {} });
      h.harness.windowEvents.get('pointerup')!({ pointerId: 1, type: 'pointerup', clientX, clientY });
    };
    h.fire('pointermove', { clientX: 120, clientY: 150 });
    click(140, 160, 2);
    const pinned = h.geometry().crosshair;
    assert.ok(pinned);
    assert.equal(h.geometry().geometry.startIndex, 180, 'a click with a tremor does not move the chart');
    h.fire('pointermove', { clientX: 250, clientY: 220 });
    assert.deepEqual(h.geometry().crosshair, pinned, 'hover does not move a pinned crosshair');
    h.fire('pointerleave');
    assert.deepEqual(h.geometry().crosshair, pinned, 'leaving keeps it');
    click(60, 80);
    assert.equal(h.geometry().crosshair, null);
    h.adapter.unmount();
  });

  it('a drag on the plot moves prices too once clearly vertical; a drag on the price axis scales them', () => {
    const h = setup();
    const before = h.geometry().geometry;
    const move = (clientX: number, clientY: number) =>
      h.harness.windowEvents.get('pointermove')!({ pointerId: 1, buttons: 1, clientX, clientY, preventDefault() {} });
    h.fire('pointerdown', { clientX: 100, clientY: 130 });
    move(100, 136); move(100, 142); move(100, 182);
    const moved = h.geometry().geometry;
    assert.equal(moved.startIndex, before.startIndex);
    assert.ok(Math.abs(moved.range - before.range) < 1e-9);
    // Taken over at 12 px, then 40 px down: higher prices at the same height.
    assert.ok(Math.abs(moved.minY - before.minY - (40 / before.innerHeight) * before.range) < 1e-9);
    h.harness.windowEvents.get('pointerup')!({ pointerId: 1, type: 'pointerup' });
    const axisX = 20 + before.padding.left + before.innerWidth + 10;
    h.fire('pointerdown', { clientX: axisX, clientY: 130 });
    move(axisX, 135); move(axisX, 180);
    const scaled = h.geometry().geometry;
    assert.ok(scaled.range > moved.range, 'the axis drag widened the range');
    assert.equal(scaled.startIndex, before.startIndex);
    h.harness.windowEvents.get('pointerup')!({ pointerId: 1, type: 'pointerup' });
    h.adapter.unmount();
  });

  it('a touch pointer has no hover; its tap pins and clears like a click', () => {
    const h = setup();
    h.fire('pointermove', { pointerType: 'touch' });
    assert.equal(h.geometry().crosshair, null);
    h.fire('pointerdown', { pointerType: 'touch' });
    h.harness.windowEvents.get('pointerup')!({ pointerId: 1, type: 'pointerup' });
    assert.ok(h.geometry().crosshair);
    h.fire('pointerdown', { pointerType: 'touch' });
    h.harness.windowEvents.get('pointerup')!({ pointerId: 1, type: 'pointerup' });
    assert.equal(h.geometry().crosshair, null);
    h.adapter.unmount();
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
    h.fire('pointerdown');
    const dragStart = h.geometry().geometry;
    h.fire('wheel', { deltaY: 120 });
    h.fire('wheel', { deltaX: 80 });
    assert.equal(h.geometry().geometry, dragStart);
    assert.equal(h.prevented(), 6);
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
