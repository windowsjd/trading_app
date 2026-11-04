import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChartHarness, elements } from './chartIntegrationHarness.cjs';
import { CHART_PRICE_LINE_COLORS, PRICE_LABEL_HEIGHT, type ChartPriceLine } from './chartPriceLines.ts';
import { formatChartPrice } from './candlestickPriceFormat.ts';

// RNGH states, sent through the installed event receiver (as the native integration test does).
const UNDETERMINED = 0, BEGAN = 2, ACTIVE = 4, END = 5;
const candles = Array.from({ length: 240 }, (_, i) => ({
  time: new Date(Date.UTC(2026, 8, 1, 0, i * 5)).toISOString(),
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i,
}));
const RED = CHART_PRICE_LINE_COLORS.average.light;
const lineColors = new Set(Object.values(CHART_PRICE_LINE_COLORS).map((color) => color.light));

function setup(extra: Record<string, unknown> = {}) {
  const harness = createChartHarness();
  const chart = harness.component('CandlestickChart.tsx', {
    candles, currencyCode: 'USD', displayPriceDecimals: 2, viewportResetKey: '5m', currentPrice: '340.5', ...extra,
  });
  chart.render();
  chart.flushEffects();
  const tree = () => chart.render();
  const rendererProps = () => elements(tree()).find((element: any) => element.props.geometry)!.props;
  const svg = () => harness.component('CandlestickChartRenderer.tsx', rendererProps()).render();
  const adapterElement = elements(tree()).find((element: any) => element.props.onPan);
  const adapter = harness.component('CandlestickGestures.native.tsx', adapterElement.props);
  const detector = adapter.render();
  adapter.flushEffects();
  const events = harness.attach(detector.props.gesture);
  const pan = events.handlers.find((handler: any) => handler.config.activeOffsetXEnd)!;
  const panBy = (translationX: number) => {
    events.handlers.forEach((handler: any) => events.state(handler, UNDETERMINED, BEGAN));
    events.state(pan, BEGAN, ACTIVE);
    events.update(pan, { translationX });
    events.state(pan, ACTIVE, END);
    chart.render(); chart.flushEffects();
  };
  return { chart, tree, rendererProps, svg, panBy };
}
const yOf = (geometry: any, price: number) => geometry.padding.top + (1 - (price - geometry.minY) / geometry.range) * geometry.innerHeight;
const priceLines = (svg: any) => elements(svg, 'line').filter((node: any) => lineColors.has(node.props.stroke));
const labels = (svg: any) => elements(svg, 'g').filter((node: any) => elements(node, 'rect').some((rect: any) => lineColors.has(rect.props.stroke)))
  .map((group: any) => ({ text: String(elements(group, 'text')[0].props.children), fill: elements(group, 'text')[0].props.fill,
    top: elements(group, 'rect')[0].props.y, x: elements(group, 'rect')[0].props.x, width: elements(group, 'rect')[0].props.width }));
const average = (price: number, note: string | null): ChartPriceLine => ({ key: 'avg', kind: 'average', price, title: '평단가', note });

describe('account price lines on the candlestick chart', () => {
  it('draws each line at its real price with a left label; the average and its return rate are red, either sign', () => {
    for (const note of ['+5.2%', '-3.25%']) {
      const h = setup({ priceLines: [average(300, note), { key: 'buy', kind: 'limit', price: 290, title: '지정가 매수' },
        { key: 'sl', kind: 'trigger', price: 320, title: '손절가' }] });
      const { geometry } = h.rendererProps();
      const drawn = priceLines(h.svg());
      assert.deepEqual(drawn.map((node: any) => [node.props.stroke, node.props.y1, node.props.y1 === node.props.y2]), [
        [RED, yOf(geometry, 300), true], [CHART_PRICE_LINE_COLORS.limit.light, yOf(geometry, 290), true], [CHART_PRICE_LINE_COLORS.trigger.light, yOf(geometry, 320), true],
      ]);
      assert.deepEqual(drawn.map((node: any) => node.props.strokeDasharray), [undefined, '6 4', '1.5 3'], 'solid, dashed, dotted: never the current price\'s 3 3');
      const found = labels(h.svg());
      assert.deepEqual(found.map((label: any) => [label.text, label.fill]), [
        [`평단가 ${formatChartPrice(300, 'USD', 2)} · ${note}`, RED],
        [`지정가 매수 ${formatChartPrice(290, 'USD', 2)}`, CHART_PRICE_LINE_COLORS.limit.light],
        [`손절가 ${formatChartPrice(320, 'USD', 2)}`, CHART_PRICE_LINE_COLORS.trigger.light],
      ]);
      assert.equal(found.every((label: any) => label.x === geometry.padding.left + 4 && label.x + label.width <= geometry.padding.left + geometry.innerWidth), true);
      const texts = elements(h.svg(), 'text').map((node: any) => String(node.props.children)).join(' ');
      assert.doesNotMatch(texts, /P&L|PnL|손익/u, 'no P&L words or amounts');
      // The current price keeps its own dashed line and axis box.
      assert.equal(elements(h.svg(), 'line').some((node: any) => node.props.strokeDasharray === '3 3'), true);
    }
  });

  it('a price outside the visible range keeps no line: its label is pinned to that edge, and the range never moves', () => {
    const plain = setup();
    const h = setup({ priceLines: [average(1000, '+1%'), { key: 'low', kind: 'limit', price: 10, title: '지정가 매수' }] });
    const { geometry } = h.rendererProps();
    for (const key of ['minY', 'maxY', 'range'] as const) assert.equal(geometry[key], plain.rendererProps().geometry[key], key);
    assert.equal(priceLines(h.svg()).length, 0);
    const [above, below] = labels(h.svg());
    assert.match(above.text, /^▲ 평단가 /u);
    assert.equal(above.top, geometry.padding.top);
    assert.match(below.text, /^▼ 지정가 매수 /u);
    assert.equal(below.top + PRICE_LABEL_HEIGHT, geometry.padding.top + geometry.innerHeight);
  });

  it('labels of lines at one price or close together never overlap and stay in the plot', () => {
    const lines: ChartPriceLine[] = [average(300, '+1%'), ...['지정가 매수', '지정가 매도', 'LOC 매수'].map((title, index) => ({ key: `l${index}`, kind: 'limit' as const, price: 300 + index * 0.2, title })),
      ...['손절가', '익절가', '조건 매수 감시가'].map((title, index) => ({ key: `t${index}`, kind: 'trigger' as const, price: 300 - index * 0.1, title }))];
    const h = setup({ priceLines: lines, height: 220 });
    const { geometry } = h.rendererProps();
    const found = labels(h.svg()).sort((a: any, b: any) => a.top - b.top);
    assert.equal(found.length, lines.length);
    for (const label of found) assert.ok(label.top >= geometry.padding.top && label.top + PRICE_LABEL_HEIGHT <= geometry.padding.top + geometry.innerHeight);
    for (let index = 1; index < found.length; index += 1) assert.ok(found[index].top >= found[index - 1].top + PRICE_LABEL_HEIGHT, 'no overlap');
    // Lines stay at their own prices; only labels make room.
    assert.equal(priceLines(h.svg()).length, lines.length);
  });

  it('the won view writes the labels in won and keeps every line where it was', () => {
    const h = setup({ priceLines: [average(300, '+5.2%')] });
    const dollarY = priceLines(h.svg())[0].props.y1;
    h.chart.props = { ...h.chart.props, currencyCode: 'KRW', displayPriceDecimals: 0, displayRate: 1384.45 };
    h.chart.render(); h.chart.flushEffects();
    assert.equal(priceLines(h.svg())[0].props.y1, dollarY);
    assert.equal(labels(h.svg())[0].text, `평단가 ${formatChartPrice(300, 'KRW', 0, 1384.45)} · +5.2%`);
    assert.match(labels(h.svg())[0].text, /원 · \+5\.2%$/u);
  });

  it('panning works as without lines; lines follow the price scale and labels clear the 최신 button', () => {
    const plain = setup();
    const h = setup({ priceLines: [average(300, '+1%'), { key: 'tp', kind: 'trigger', price: 335, title: '익절가' }] });
    plain.panBy(120);
    h.panBy(120);
    const moved = h.rendererProps();
    for (const key of ['startIndex', 'minY', 'maxY'] as const) assert.equal(moved.geometry[key], plain.rendererProps().geometry[key], key);
    assert.ok(moved.geometry.startIndex < 180, 'the view moved into history');
    for (const line of priceLines(h.svg())) {
      const price = line.props.stroke === RED ? 300 : 335;
      const y = yOf(moved.geometry, price);
      if (y >= moved.geometry.padding.top && y <= moved.geometry.padding.top + moved.geometry.innerHeight) assert.equal(line.props.y1, y);
    }
    // The reset button shows now: labels start below it (its default size until measured).
    assert.equal(moved.labelTop, 40);
    assert.equal(labels(h.svg()).every((label: any) => label.top >= 40), true);
    const reset = elements(h.tree()).find((element: any) => element.props.accessibilityLabel === '차트를 최신 구간으로 초기화')!;
    reset.props.onLayout({ nativeEvent: { layout: { x: 8, y: 8, width: 52, height: 41.5 } } });
    assert.equal(h.rendererProps().labelTop, 54, 'a larger font\'s taller button');
    reset.props.onPress();
    assert.equal(h.rendererProps().labelTop, 0, 'back at the latest window, no button');
  });

  it('the chart\'s spoken summary names every line', () => {
    const h = setup({ priceLines: [average(300, '+5.2%'), { key: 'buy', kind: 'limit', price: 290, title: '지정가 매수', note: '2건' }] });
    const box = elements(h.tree()).find((element: any) => element.props.accessibilityRole === 'image')!;
    assert.ok(box.props.accessibilityLabel.endsWith(
      `평단가 ${formatChartPrice(300, 'USD', 2)} · +5.2%, 지정가 매수 ${formatChartPrice(290, 'USD', 2)} · 2건`), box.props.accessibilityLabel);
  });
});
