import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PRICE_LABEL_GAP,
  PRICE_LABEL_HEIGHT,
  chartPrice,
  chartPriceLineLabel,
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
