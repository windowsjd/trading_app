import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChartHarness, elements } from './chartIntegrationHarness.cjs';
import { AXIS_LABEL_HEIGHT, AXIS_TITLE_HEIGHT, CHART_PRICE_LINE_COLORS, PRICE_LABEL_GAP, PRICE_LABEL_HEIGHT, type ChartPriceLine } from './chartPriceLines.ts';
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
  return { harness, chart, tree, rendererProps, svg, panBy };
}
const yOf = (geometry: any, price: number) => geometry.padding.top + (1 - (price - geometry.minY) / geometry.range) * geometry.innerHeight;
const rightEdge = (geometry: any) => geometry.padding.left + geometry.innerWidth;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const priceLines = (svg: any) => elements(svg, 'line').filter((node: any) => lineColors.has(node.props.stroke));
// A box's rows joined by a line break (the axis box: title over price); one fill when every row shares it.
const boxes = (svg: any) => elements(svg, 'g').filter((node: any) => elements(node, 'rect').some((rect: any) => lineColors.has(rect.props.stroke)))
  .map((group: any) => ({ text: elements(group, 'text').map((node: any) => String(node.props.children)).join('\n'),
    fill: [...new Set(elements(group, 'text').map((node: any) => node.props.fill))].join(','),
    rows: elements(group, 'text').map((node: any) => ({ y: node.props.y, fontSize: node.props.fontSize, bold: node.props.fontWeight === 'bold' })),
    top: elements(group, 'rect')[0].props.y, x: elements(group, 'rect')[0].props.x, width: elements(group, 'rect')[0].props.width,
    height: elements(group, 'rect')[0].props.height }));
// The axis box's price row center (its rect is inset by half its outline).
const priceRow = (box: any) => box.top - 0.5 + AXIS_TITLE_HEIGHT + PRICE_LABEL_HEIGHT / 2;
// Left labels sit in the plot; the average's title-and-price box on the right axis, past the plot's edge.
const labels = (h: ReturnType<typeof setup>) => boxes(h.svg()).filter((box: any) => box.x < rightEdge(h.rendererProps().geometry));
const axisLabels = (h: ReturnType<typeof setup>) => boxes(h.svg()).filter((box: any) => box.x >= rightEdge(h.rendererProps().geometry));
const texts = (svg: any) => elements(svg, 'text').map((node: any) => String(node.props.children));
// The current price's own filled box on the axis (the average's is inset by half its outline).
const currentBox = (svg: any, geometry: any) => elements(svg, 'rect').find((rect: any) => rect.props.x === rightEdge(geometry) && rect.props.width === geometry.padding.right);
const average = (price: number, note: string | null): ChartPriceLine => ({ key: 'avg', kind: 'average', price, title: '평단가', note });
const usd = (price: number) => formatChartPrice(price, 'USD', 2);

describe('account price lines on the candlestick chart', () => {
  it('draws each line at its real price; the average\'s return rate sits at the left and its price on the right axis, both red, either sign', () => {
    for (const note of ['+5.2%', '-3.25%']) {
      const h = setup({ priceLines: [average(300, note), { key: 'buy', kind: 'limit', price: 290, title: '지정가 매수' },
        { key: 'sl', kind: 'trigger', price: 320, title: '손절가' }] });
      const { geometry } = h.rendererProps();
      const drawn = priceLines(h.svg());
      assert.deepEqual(drawn.map((node: any) => [node.props.stroke, node.props.y1, node.props.y1 === node.props.y2]), [
        [RED, yOf(geometry, 300), true], [CHART_PRICE_LINE_COLORS.limit.light, yOf(geometry, 290), true], [CHART_PRICE_LINE_COLORS.trigger.light, yOf(geometry, 320), true],
      ]);
      assert.deepEqual(drawn.map((node: any) => node.props.strokeDasharray), [undefined, '6 4', '1.5 3'], 'solid, dashed, dotted: never the current price\'s 3 3');
      const found = labels(h);
      assert.deepEqual(found.map((label: any) => [label.text, label.fill]), [
        [note, RED],
        [`지정가 매수 ${usd(290)}`, CHART_PRICE_LINE_COLORS.limit.light],
        [`손절가 ${usd(320)}`, CHART_PRICE_LINE_COLORS.trigger.light],
      ]);
      assert.equal(found.every((label: any) => label.x === geometry.padding.left + 4 && label.x + label.width <= rightEdge(geometry)), true);
      // Only the average's price moves to the axis, under its title: the price row on its line, inside the axis gutter.
      const axis = axisLabels(h);
      assert.deepEqual(axis.map((label: any) => [label.text, label.fill]), [[`평단가\n${usd(300)}`, RED]]);
      assert.equal(near(priceRow(axis[0]), yOf(geometry, 300)), true, 'the price row on its line');
      assert.equal(near(axis[0].height, AXIS_LABEL_HEIGHT - 1), true, 'a title row over a price row');
      assert.equal(axis[0].x + axis[0].width <= geometry.width, true, 'inside the chart');
      const [title, price] = axis[0].rows;
      assert.equal(title.y > axis[0].top && title.y <= axis[0].top - 0.5 + AXIS_TITLE_HEIGHT, true, 'the title in its own row');
      assert.equal(near(price.y, yOf(geometry, 300) + 3), true, 'the price on its line, as the current price is on its own');
      assert.equal(!title.bold && price.bold && title.fontSize <= 9 && price.fontSize <= 9, true, 'the price reads first');
      const shown = texts(h.svg());
      assert.doesNotMatch(shown.join(' '), /P&L|PnL|손익/u, 'no P&L words');
      assert.deepEqual(shown.filter((text) => text.includes('평단가')), ['평단가'], 'the title once, on the axis only');
      // The current price keeps its own dashed line and axis box.
      assert.equal(elements(h.svg(), 'line').some((node: any) => node.props.strokeDasharray === '3 3'), true);
      assert.equal(shown.includes(usd(340.5)), true);
    }
  });

  it('the return rate at the left and the axis price sit on the same line', () => {
    const h = setup({ priceLines: [average(300, '-10.52%')] });
    const y = yOf(h.rendererProps().geometry, 300);
    const [rate] = labels(h);
    assert.equal(rate.text, '-10.52%');
    assert.equal(near(rate.top + PRICE_LABEL_HEIGHT / 2, y) && near(priceRow(axisLabels(h)[0]), y), true, `${rate.top} / ${axisLabels(h)[0].top} vs ${y}`);
  });

  it('with no return rate the average keeps its line and axis price but shows no rate at the left', () => {
    const h = setup({ priceLines: [average(300, null), { key: 'buy', kind: 'limit', price: 290, title: '지정가 매수' }] });
    assert.deepEqual(labels(h).map((label: any) => label.text), [`지정가 매수 ${usd(290)}`]);
    assert.deepEqual(axisLabels(h).map((label: any) => [label.text, label.fill]), [[`평단가\n${usd(300)}`, RED]]);
    assert.equal(priceLines(h.svg()).length, 2);
    assert.equal(texts(h.svg()).some((text) => text.includes('%')), false, 'no rate is made up');
    // A futures position's average keeps its own title over the price.
    const futures = setup({ priceLines: [{ ...average(300, null), title: '숏 진입가' }] });
    assert.deepEqual(axisLabels(futures).map((label: any) => label.text), [`숏 진입가\n${usd(300)}`]);
  });

  it('a price outside the visible range keeps no line: its labels are pinned to that edge, and the range never moves', () => {
    const plain = setup();
    const h = setup({ priceLines: [average(1000, '+1%'), { key: 'low', kind: 'limit', price: 10, title: '지정가 매수' }] });
    const { geometry } = h.rendererProps();
    for (const key of ['minY', 'maxY', 'range'] as const) assert.equal(geometry[key], plain.rendererProps().geometry[key], key);
    assert.equal(priceLines(h.svg()).length, 0);
    const [above, below] = labels(h);
    assert.equal(above.text, '▲ +1%');
    assert.equal(above.top, geometry.padding.top);
    assert.match(below.text, /^▼ 지정가 매수 /u);
    assert.equal(below.top + PRICE_LABEL_HEIGHT, geometry.padding.top + geometry.innerHeight);
    // The axis price is pinned too, at the plot's top edge (clear of the current price's box), its arrow on the title row.
    const [axis] = axisLabels(h);
    assert.equal(axis.text, `▲ 평단가\n${usd(1000)}`);
    const current = currentBox(h.svg(), geometry)!.props.y;
    assert.ok(axis.top + axis.height <= current || axis.top >= current + PRICE_LABEL_HEIGHT, 'clear of the current price');
    const low = setup({ priceLines: [average(10, null)] });
    assert.equal(labels(low).length, 0);
    assert.deepEqual(axisLabels(low).map((label: any) => label.text), [`▼ 평단가\n${usd(10)}`]);
    assert.equal(near(priceRow(axisLabels(low)[0]), geometry.padding.top + geometry.innerHeight), true, 'the price row on the bottom edge');
  });

  it('labels of lines at one price or close together never overlap and stay in the plot', () => {
    const lines: ChartPriceLine[] = [average(300, '+1%'), ...['지정가 매수', '지정가 매도', 'LOC 매수'].map((title, index) => ({ key: `l${index}`, kind: 'limit' as const, price: 300 + index * 0.2, title })),
      ...['손절가', '익절가', '조건 매수 감시가'].map((title, index) => ({ key: `t${index}`, kind: 'trigger' as const, price: 300 - index * 0.1, title }))];
    const h = setup({ priceLines: lines, height: 220 });
    const { geometry } = h.rendererProps();
    const found = labels(h).sort((a: any, b: any) => a.top - b.top);
    assert.equal(found.length, lines.length);
    for (const label of found) assert.ok(label.top >= geometry.padding.top && label.top + PRICE_LABEL_HEIGHT <= geometry.padding.top + geometry.innerHeight);
    for (let index = 1; index < found.length; index += 1) assert.ok(found[index].top >= found[index - 1].top + PRICE_LABEL_HEIGHT, 'no overlap');
    assert.deepEqual(axisLabels(h).map((label: any) => label.text), [`평단가\n${usd(300)}`]);
    // Lines stay at their own prices; only labels make room.
    assert.equal(priceLines(h.svg()).length, lines.length);
  });

  it('the axis price steps aside for the current price, whose box never moves; a tick it covers drops its text', () => {
    const plain = setup();
    const { geometry } = plain.rendererProps();
    const current = currentBox(plain.svg(), geometry)!.props.y;
    const h = setup({ priceLines: [average(340.5, '+1%')] });
    const svg = h.svg();
    assert.equal(priceLines(svg)[0].props.y1, yOf(geometry, 340.5), 'the line stays at its price');
    assert.equal(currentBox(svg, geometry)!.props.y, current, 'the current price box never moves');
    const [axis] = axisLabels(h);
    assert.equal(axis.text, `평단가\n${usd(340.5)}`);
    // Right beside the current price's box (under it, or over it by its whole height), with the labels' gap, inside the axis.
    const boxTop = axis.top - 0.5;
    assert.equal(near(boxTop, current + PRICE_LABEL_HEIGHT + PRICE_LABEL_GAP) || near(boxTop + AXIS_LABEL_HEIGHT + PRICE_LABEL_GAP, current), true, `${boxTop} vs ${current}`);
    assert.ok(boxTop >= geometry.padding.top - PRICE_LABEL_HEIGHT / 2 && boxTop + AXIS_LABEL_HEIGHT <= geometry.padding.top + geometry.innerHeight + PRICE_LABEL_HEIGHT / 2);
    // The middle tick under an average there keeps its line but not its text; the other ticks keep theirs.
    const ticks = [0, 1, 2, 3, 4].map((index) => usd(geometry.minY + (geometry.range * index) / 4));
    const covered = setup({ priceLines: [average(geometry.minY + (geometry.range * 2) / 4, '+1%')] });
    assert.deepEqual(axisLabels(covered).map((label: any) => label.text), [`평단가\n${ticks[2]}`]);
    const coveredTexts = texts(covered.svg());
    assert.equal(coveredTexts.filter((text) => text === ticks[2]).length, 1, 'only the axis price, no tick text under it');
    assert.equal(texts(plain.svg()).filter((text) => text === ticks[2]).length, 1, 'the tick text without the line');
    for (const tick of [ticks[0], ticks[1], ticks[3], ticks[4]]) assert.equal(coveredTexts.includes(tick), true, tick);
  });

  it('the crosshair\'s box is drawn over the axis price while scrubbing', () => {
    const h = setup({ priceLines: [average(300, '+1%')] });
    const props = h.rendererProps();
    const y = yOf(props.geometry, 300);
    const svg = h.harness.component('CandlestickChartRenderer.tsx', { ...props, crosshair: { index: props.candles.at(-1).index, y } }).render();
    const rects = elements(svg, 'rect');
    const axis = rects.findIndex((rect: any) => rect.props.stroke === RED && rect.props.x > rightEdge(props.geometry));
    const crosshair = rects.findIndex((rect: any) => rect.props.x === rightEdge(props.geometry) && rect.props.y === y - 8);
    assert.equal(axis >= 0 && crosshair > axis, true, `axis ${axis}, crosshair ${crosshair}`);
  });

  it('the won view writes the labels in won and keeps every line where it was', () => {
    const h = setup({ priceLines: [average(300, '+5.2%')] });
    const dollarY = priceLines(h.svg())[0].props.y1;
    h.chart.props = { ...h.chart.props, currencyCode: 'KRW', displayPriceDecimals: 0, displayRate: 1384.45 };
    h.chart.render(); h.chart.flushEffects();
    assert.equal(priceLines(h.svg())[0].props.y1, dollarY);
    assert.equal(labels(h)[0].text, '+5.2%');
    assert.deepEqual(axisLabels(h).map((label: any) => label.text), [`평단가\n${formatChartPrice(300, 'KRW', 0, 1384.45)}`]);
    assert.match(axisLabels(h)[0].text, /^평단가\n[\d,]+원$/u);
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
    assert.equal(labels(h).every((label: any) => label.top >= 40), true);
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
      `평단가 ${usd(300)} · +5.2%, 지정가 매수 ${usd(290)} · 2건`), box.props.accessibilityLabel);
  });
});
