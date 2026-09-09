import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChartHarness, elements } from './chartIntegrationHarness.cjs';
import { formatKrwDecimal } from '../../utils/format.ts';
const points = [10, 40, 25, 20, 60].map((y, i) => ({
  x: `2026-09-0${i + 1}`,
  y: String(y),
}));
function setup(extra = {}, platform = 'android') {
  const h = createChartHarness(platform);
  const chart = h.component('LineChart.tsx', { points, ...extra });
  const render = () => chart.render();
  const props = elements(render()).find(
    (element) => element.props.onSelect,
  )!.props;
  const select = props.onSelect;
  const dot = () => elements(render(), 'circle')[0].props;
  const text = () =>
    elements(render(), 'Text')
      .map((element) => element.props.children)
      .flat()
      .join('');
  const guides = () =>
    elements(render(), 'line').filter(
      (element) => element.props.strokeDasharray,
    );
  return { h, chart, render, props, select, dot, text, guides };
}
describe('LineChart actual renderer and native/web integration', () => {
  it('selects first, middle, last and nearest actual point, with exact dot and guides', () => {
    const h = setup();
    for (const [x, index] of [
      [0, 0],
      [150, 2],
      [10000, 4],
      [110, 1],
      [240, 3],
    ]) {
      h.select(x);
      assert.ok(h.text().includes(points[index].x));
      assert.ok(h.text().includes(points[index].y));
      const dot = h.dot();
      assert.equal(dot.cx, 12 + (index / 4) * 296);
      assert.equal(
        dot.cy,
        12 + (1 - (Number(points[index].y) - 10) / 50) * 156,
      );
      assert.equal(h.guides()[0].props.y1, dot.cy);
      assert.equal(h.guides()[1].props.x1, dot.cx);
      assert.equal(elements(h.render(), 'circle').length, 1);
      assert.ok(
        elements(h.render(), 'path')[0].props.d.includes(`${dot.cx} ${dot.cy}`),
      );
    }
    h.select(null);
    assert.equal(h.guides().length, 0);
    assert.ok(h.text().includes('최신 값'));
    assert.ok(h.text().includes(points.at(-1)!.x));
  });
  it('keeps every real point selectable beyond the previous 80 point drawing cap', () => {
    const data = Array.from({ length: 300 }, (_, i) => ({
      x: `point-${i}`,
      y: String(i),
    }));
    const h = setup({ points: data });
    h.select(12 + (123 / 299) * 296);
    assert.ok(h.text().includes('point-123'));
    assert.equal(h.dot().cx, 12 + (123 / 299) * 296);
  });
  it('supports a single snapshot, flat data, long labels and exact large amounts at Android widths', () => {
    for (const data of [[points[0]], points.map((p) => ({ ...p, y: '10' }))]) {
      const h = setup({ points: data });
      h.select(160);
      assert.equal(h.dot().cy, 90);
    }
    for (const width of [230, 254, 294, 650]) {
      const value = '9007199254740993.00000000';
      const label = '2026-09-09 아주 긴 날짜 설명';
      const h = setup({
        points: [{ x: label, y: value }],
        pointValueFormatter: (point) => formatKrwDecimal(point.y) + '원',
      });
      h.render().props.onLayout({ nativeEvent: { layout: { width } } });
      const select = elements(h.render()).find((node) => node.props.onSelect)!
        .props.onSelect;
      select(width / 2);
      assert.equal(h.dot().cx, width / 2);
      assert.ok(h.text().includes('9,007,199,254,740,993원'));
      assert.ok(h.text().includes(label));
      assert.ok(
        elements(h.render(), 'Text').every(
          (node) => node.props.numberOfLines === undefined,
        ),
      );
    }
  });
  it('clears selection synchronously on account/range data changes and rotation', () => {
    const h = setup();
    h.select(0);
    h.chart.props = { points: [{ x: 'new account', y: '999' }] };
    assert.equal(h.guides().length, 0);
    assert.ok(!h.text().includes('2026-09-01'));
    const again = setup();
    again.select(0);
    again.render().props.onLayout({ nativeEvent: { layout: { width: 254 } } });
    assert.equal(again.guides().length, 0);
  });
  it('uses installed native recognizer: down preview, horizontal updates, release/cancel/vertical failure reset', () => {
    for (const terminal of [1, 3, 5]) {
      const h = setup();
      const adapter = h.h.component('LineChartGestures.native.tsx', h.props);
      const detector = adapter.render();
      const events = h.h.attach(detector.props.gesture);
      const pan = events.handlers[0];
      assert.equal(pan.config.activeOffsetXStart, -8);
      assert.equal(pan.config.activeOffsetXEnd, 8);
      assert.equal(pan.config.failOffsetYStart, -8);
      assert.equal(pan.config.failOffsetYEnd, 8);
      assert.equal(pan.config.maxPointers, 1);
      assert.equal(pan.shouldUseReanimated, false);
      events.state(pan, 0, 2);
      events.update(pan, {
        eventType: 1,
        numberOfTouches: 1,
        allTouches: [{ x: 12, y: 90 }],
        changedTouches: [{ x: 12, y: 90 }],
      });
      assert.ok(h.text().includes('2026-09-01'));
      if (terminal === 1) {
        events.state(pan, 2, 1); // Vertical native failure gives ScrollView control.
      } else {
        events.state(pan, 2, 4, { x: 160 });
        assert.ok(h.text().includes('2026-09-03'));
        events.update(pan, { x: 308 });
        assert.ok(h.text().includes('2026-09-05'));
        events.state(pan, 4, terminal);
      }
      assert.equal(h.guides().length, 0);
    }
  });
  it('web hover and touch scrubbing work, vertical swipe and pointer endings clear without consuming scroll', () => {
    const h = setup({}, 'web');
    const adapter = h.h.component('LineChartGestures.web.tsx', h.props);
    const listeners = new Map();
    const view = adapter.render();
    view.props.ref.current = {
      getBoundingClientRect: () => ({ left: 20 }),
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name) => listeners.delete(name),
    };
    adapter.flushEffects();
    assert.equal(view.props.style.touchAction, 'pan-y');
    const fire = (name, fields = {}) =>
      listeners.get(name)({
        clientX: 32,
        clientY: 80,
        pointerType: 'mouse',
        ...fields,
      });
    fire('pointermove');
    assert.ok(h.text().includes('2026-09-01'));
    fire('pointerdown');
    fire('pointermove', { clientX: 180 });
    assert.ok(h.text().includes('2026-09-03'));
    h.h.windowEvents.get('pointerup')!();
    assert.equal(h.guides().length, 0);
    fire('pointerdown', { pointerType: 'touch' });
    fire('pointermove', { clientY: 100, pointerType: 'touch' });
    assert.equal(h.guides().length, 0);
    h.h.windowEvents.get('pointercancel')!();
    fire('pointermove');
    fire('pointerleave');
    assert.equal(h.guides().length, 0);
    assert.ok(!listeners.has('wheel'));
    adapter.unmount();
    assert.equal(listeners.size, 0);
    assert.equal(h.h.windowEvents.size, 0);
  });
});

describe('home chart money and allocation boundaries', () => {
  it('rounds only the displayed KRW decimal digits, preserving integer precision', () => {
    for (const [raw, expected] of [
      ['10.00000000', '10'],
      ['10.49999999', '10'],
      ['10.50000000', '11'],
      ['9999999999999999.99999999', '10,000,000,000,000,000'],
    ]) {
      assert.equal(formatKrwDecimal(raw), expected);
    }
  });
  it('renders the supplied portfolio total/segment strings and wraps long legends; zero/empty remains empty', () => {
    const h = createChartHarness();
    const segments = [
      {
        key: 'long',
        label: '아주 긴 국내 주식 분류 이름',
        value: '9007199254740993.00000000',
      },
    ];
    const chart = h.component('DonutChart.tsx', {
      segments,
      totalLabel: 'backend total',
      segmentValueFormatter: (segment) =>
        formatKrwDecimal(segment.value) + '원',
    });
    const tree = chart.render();
    const labels = elements(tree, 'Text')
      .flatMap((node) => node.props.children)
      .join('');
    assert.ok(labels.includes('backend total'));
    assert.ok(labels.includes('9,007,199,254,740,993원'));
    assert.ok(labels.includes(segments[0].label));
    assert.ok(
      elements(tree, 'Text').every(
        (node) => node.props.numberOfLines === undefined,
      ),
    );
    for (const empty of [
      [],
      [{ key: 'cash', label: '현금', value: '0.00000000' }],
    ]) {
      const blank = h
        .component('DonutChart.tsx', { segments: empty, emptyMessage: 'empty' })
        .render();
      assert.equal(blank.props.message, 'empty');
    }
  });
});
