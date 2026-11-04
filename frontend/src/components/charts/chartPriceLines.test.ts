import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AXIS_LABEL_HEIGHT,
  AXIS_TITLE_HEIGHT,
  PRICE_LABEL_GAP,
  PRICE_LABEL_HEIGHT,
  chartPrice,
  chartPriceLineLabel,
  chartPriceLineTexts,
  layoutAxisLabels,
  layoutPriceLabels,
  mergeChartPriceLines,
  priceLabelBox,
  type ChartPriceLine,
  type PriceLabelRequest,
} from './chartPriceLines.ts';
import { chartLabelWidth } from './candlestickLayout.ts';

const line = (key: string, kind: ChartPriceLine['kind'], price: number, title: string = kind): ChartPriceLine => ({ key, kind, price, title });

function assertNoOverlap(tops: Map<string, number>, bounds: { top: number; bottom: number }) {
  const sorted = [...tops.values()].sort((a, b) => a - b);
  for (const top of sorted) {
    assert.ok(top >= bounds.top - 1e-9 && top + PRICE_LABEL_HEIGHT <= bounds.bottom + 1e-9, `label ${top} outside ${bounds.top}..${bounds.bottom}`);
  }
  for (let index = 1; index < sorted.length; index += 1)
    assert.ok(sorted[index] - sorted[index - 1] >= PRICE_LABEL_HEIGHT + PRICE_LABEL_GAP - 1e-9, `labels at ${sorted[index - 1]} and ${sorted[index]} overlap`);
}

describe('price label layout', () => {
  const bounds = { top: 12, bottom: 250 };

  it('keeps each label on its line when there is room', () => {
    const tops = layoutPriceLabels([
      { key: 'a', kind: 'average', y: 60 }, { key: 'b', kind: 'limit', y: 120 }, { key: 'c', kind: 'trigger', y: 200 },
    ], bounds);
    assert.deepEqual([...tops.entries()], [['a', 52], ['b', 112], ['c', 192]]);
  });

  it('separates labels at the same or nearby prices, in price order, inside the plot', () => {
    const requests: PriceLabelRequest[] = [
      { key: 'limit-1', kind: 'limit', y: 100 }, { key: 'avg', kind: 'average', y: 100 }, { key: 'sl', kind: 'trigger', y: 101 },
      { key: 'tp', kind: 'trigger', y: 104 }, { key: 'low', kind: 'limit', y: 249 }, { key: 'lower', kind: 'trigger', y: 250 },
      { key: 'top', kind: 'trigger', y: 12 }, { key: 'top-2', kind: 'limit', y: 13 },
    ];
    const tops = layoutPriceLabels(requests, bounds);
    assert.equal(tops.size, requests.length);
    assertNoOverlap(tops, bounds);
    // Vertical order follows the lines; the average price wins a tie.
    const order = [...tops.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
    assert.deepEqual(order, ['top', 'top-2', 'avg', 'limit-1', 'sl', 'tp', 'low', 'lower']);
  });

  it('when more labels than fit, drops the lowest priority ones and never stacks the rest', () => {
    const small = { top: 12, bottom: 12 + 4 * (PRICE_LABEL_HEIGHT + PRICE_LABEL_GAP) - PRICE_LABEL_GAP };
    const requests: PriceLabelRequest[] = [
      ...Array.from({ length: 5 }, (_, index) => ({ key: `trigger-${index}`, kind: 'trigger' as const, y: 30 })),
      { key: 'limit', kind: 'limit', y: 30 }, { key: 'avg', kind: 'average', y: 30 },
    ];
    const tops = layoutPriceLabels(requests, small);
    assert.deepEqual([...tops.keys()].sort(), ['avg', 'limit', 'trigger-0', 'trigger-1']);
    assertNoOverlap(tops, small);
    assert.equal(layoutPriceLabels(requests, { top: 0, bottom: PRICE_LABEL_HEIGHT - 1 }).size, 0, 'no room, no labels');
  });

  it('randomized label sets never overlap and never leave the plot', () => {
    let seed = 11;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let round = 0; round < 300; round += 1) {
      const height = 40 + next() * 400;
      const box = { top: 12, bottom: 12 + height };
      const requests = Array.from({ length: 1 + Math.floor(next() * 12) }, (_, index) => ({
        key: `k${index}`, kind: (['average', 'limit', 'trigger'] as const)[index % 3], y: -50 + next() * (height + 100),
      }));
      assertNoOverlap(layoutPriceLabels(requests, box), box);
    }
  });
});

describe('axis label layout', () => {
  const bounds = { top: 4, bottom: 266 };
  // A box's top when its price row is centered on `y`; the fixed (current price) box's edges at `y`.
  const centered = (y: number) => y - AXIS_TITLE_HEIGHT - PRICE_LABEL_HEIGHT / 2;
  const above = (y: number) => y - PRICE_LABEL_HEIGHT / 2 - PRICE_LABEL_GAP - AXIS_LABEL_HEIGHT;
  const below = (y: number) => y + PRICE_LABEL_HEIGHT / 2 + PRICE_LABEL_GAP;
  // Boxes as [top, height]: the axis boxes and the current price's.
  function assertNoBoxOverlap(boxes: [number, number][], box: { top: number; bottom: number }) {
    const sorted = [...boxes].sort((a, b) => a[0] - b[0]);
    for (const [top, height] of sorted) assert.ok(top >= box.top - 1e-9 && top + height <= box.bottom + 1e-9, `box ${top} outside ${box.top}..${box.bottom}`);
    for (let index = 1; index < sorted.length; index += 1)
      assert.ok(sorted[index][0] >= sorted[index - 1][0] + sorted[index - 1][1] + PRICE_LABEL_GAP - 1e-9, `boxes at ${sorted[index - 1][0]} and ${sorted[index][0]} overlap`);
  }
  const withFixed = (tops: Map<string, number>, fixed: number[]): [number, number][] => [
    ...[...tops.values()].map((top) => [top, AXIS_LABEL_HEIGHT] as [number, number]),
    ...fixed.map((y) => [y - PRICE_LABEL_HEIGHT / 2, PRICE_LABEL_HEIGHT] as [number, number]),
  ];

  it('centers each price row on its line, its title row above, when nothing is in the way', () => {
    assert.deepEqual([...layoutAxisLabels([{ key: 'a', y: 100 }, { key: 'b', y: 200 }], [], bounds).entries()], [['a', centered(100)], ['b', centered(200)]]);
    assert.equal(centered(100), 100 - 20, 'a 12 px title row over a 16 px price row');
    // A line on the plot's bottom edge keeps its price row on it; at the top edge the title row needs the room.
    assert.deepEqual([...layoutAxisLabels([{ key: 'top', y: 12 }, { key: 'bottom', y: 258 }], [], bounds).entries()], [['top', 4], ['bottom', centered(258)]]);
    assert.equal(centered(258) + AXIS_LABEL_HEIGHT, bounds.bottom);
  });

  it('steps aside for a fixed label to the nearer free side, and never moves it', () => {
    assert.deepEqual([...layoutAxisLabels([{ key: 'a', y: 98 }], [100], bounds).entries()], [['a', above(100)]]);
    // The box reaches up, so a line just under the current price still goes above it; one further down goes below.
    assert.deepEqual([...layoutAxisLabels([{ key: 'a', y: 103 }], [100], bounds).entries()], [['a', above(100)]]);
    assert.deepEqual([...layoutAxisLabels([{ key: 'a', y: 110 }], [100], bounds).entries()], [['a', below(100)]]);
    // No room above the fixed label: below it.
    assert.deepEqual([...layoutAxisLabels([{ key: 'a', y: 12 }], [14], bounds).entries()], [['a', below(14)]]);
    // Two labels at one price stack beside each other and the fixed one.
    const tops = layoutAxisLabels([{ key: 'a', y: 100 }, { key: 'b', y: 100 }], [100], bounds);
    assertNoBoxOverlap(withFixed(tops, [100]), bounds);
    assert.equal(tops.size, 2);
  });

  it('drops a label that finds no room rather than drawing it over another', () => {
    const tight = { top: 0, bottom: PRICE_LABEL_HEIGHT + PRICE_LABEL_GAP + AXIS_LABEL_HEIGHT };
    assert.deepEqual([...layoutAxisLabels([{ key: 'a', y: 8 }, { key: 'b', y: 9 }], [8], tight).entries()], [['a', PRICE_LABEL_HEIGHT + PRICE_LABEL_GAP]]);
    assert.equal(layoutAxisLabels([{ key: 'a', y: 8 }], [], { top: 0, bottom: AXIS_LABEL_HEIGHT - 1 }).size, 0);
  });

  it('randomized labels never overlap each other or the fixed ones, and stay in bounds', () => {
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let round = 0; round < 300; round += 1) {
      const height = 40 + next() * 400;
      const box = { top: 4, bottom: 4 + height };
      const fixed = next() < 0.8 ? [box.top + PRICE_LABEL_HEIGHT / 2 + next() * (height - PRICE_LABEL_HEIGHT)] : [];
      const requests = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, index) => ({ key: `k${index}`, y: -50 + next() * (height + 100) }));
      const tops = layoutAxisLabels(requests, fixed, box);
      assertNoBoxOverlap(withFixed(tops, fixed), box);
      // Beside one fixed label there is always room for one box once the axis holds it and two boxes.
      if (height >= PRICE_LABEL_HEIGHT + 2 * (AXIS_LABEL_HEIGHT + PRICE_LABEL_GAP)) assert.equal(tops.size >= 1, true, 'the first label finds room');
    }
  });
});

describe('price line data', () => {
  it('merges same-kind lines at one price into one counted label, never the average price', () => {
    const merged = mergeChartPriceLines([
      line('avg', 'average', 100, '평단가'), line('l1', 'limit', 95, '지정가 매수'), line('l2', 'limit', 95, '지정가 매수'),
      line('l3', 'limit', 95, '지정가 매도'), line('t1', 'trigger', 95, '손절가'),
    ]);
    assert.deepEqual(merged.map((item) => [item.key, item.title, item.note ?? null]), [
      ['avg', '평단가', null], ['l1', '지정가 매수', '2건'], ['l3', '지정가 매도', null], ['t1', '손절가', null],
    ]);
  });

  it('labels a line as its name, the price and its note — with an arrow when pinned to an edge', () => {
    const average = { ...line('avg', 'average', 100, '평단가'), note: '-3.21%' };
    assert.equal(chartPriceLineLabel(average, '$100.00', null), '평단가 $100.00 · -3.21%');
    assert.equal(chartPriceLineLabel(average, '$100.00', 'above'), '▲ 평단가 $100.00 · -3.21%');
    assert.equal(chartPriceLineLabel(line('l', 'limit', 1, '지정가 매수'), '1,000원', 'below'), '▼ 지정가 매수 1,000원');
  });

  it('splits the average: its signed return rate at the left, its title over its price on the axis; others keep one left label', () => {
    for (const note of ['-10.52%', '+5.2%', '0%']) {
      const average = { ...line('avg', 'average', 242242, '평단가'), note };
      assert.deepEqual(chartPriceLineTexts(average, '242,242원', null), { plot: note, axis: { title: '평단가', price: '242,242원' } });
      // A pinned one's arrow goes on the title row: the price keeps the axis's size.
      assert.deepEqual(chartPriceLineTexts(average, '242,242원', 'above'), { plot: `▲ ${note}`, axis: { title: '▲ 평단가', price: '242,242원' } });
      assert.deepEqual(chartPriceLineTexts(average, '242,242원', 'below'), { plot: `▼ ${note}`, axis: { title: '▼ 평단가', price: '242,242원' } });
    }
    // No rate (unavailable valuation, stale futures ROI): no left label, never a made-up one. A futures
    // position keeps its own title, so a long and a short entry never read alike.
    for (const note of [null, undefined, '']) {
      assert.deepEqual(chartPriceLineTexts({ ...line('avg', 'average', 100, '롱 진입가'), note }, '$100.00', null),
        { plot: null, axis: { title: '롱 진입가', price: '$100.00' } });
    }
    assert.deepEqual(chartPriceLineTexts({ ...line('l', 'limit', 1, '지정가 매수'), note: '2건' }, '1,000원', 'below'), { plot: '▼ 지정가 매수 1,000원 · 2건', axis: null });
    assert.deepEqual(chartPriceLineTexts(line('t', 'trigger', 1, '손절가'), '$1.00', null), { plot: '손절가 $1.00', axis: null });
  });

  it('fits a long label into a narrow plot by shrinking the text, never past the plot', () => {
    const text = '▲ 조건 롱 감시가 $123,456.78901 · 2건';
    const wide = priceLabelBox(text, 400);
    assert.equal(wide.fontSize, 10);
    const narrow = priceLabelBox(text, 120);
    assert.ok(narrow.fontSize < 10 && narrow.width <= 120);
    assert.ok(chartLabelWidth(text, narrow.fontSize) <= 120 - 2 * narrow.textInset + 1e-9);
  });

  it('only parses positive decimal prices', () => {
    assert.deepEqual(['100', '0.00001234', ' 7.5 ', '0', '-1', '1e3', '', null, 'abc'].map(chartPrice), [100, 0.00001234, 7.5, null, null, null, null, null, null]);
  });
});
