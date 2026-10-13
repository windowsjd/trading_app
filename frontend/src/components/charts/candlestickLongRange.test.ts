import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChartHarness, elements } from './chartIntegrationHarness.cjs';
import { DEFAULT_VISIBLE_CANDLES } from './candlestickViewport.ts';

// The long-range 4h window: 96 crypto days × 6 closed buckets + the current
// bucket = 577 candles in one response (limit 600).
const LONG_RANGE_CANDLES = 96 * 6 + 1;
const H4 = 4 * 3600_000;

function setup(total: number) {
  const harness = createChartHarness('web');
  const start = Date.UTC(2026, 6, 9, 8);
  const chart = harness.component('CandlestickChart.tsx', {
    candles: Array.from({ length: total }, (_, i) => ({
      time: new Date(start + i * H4).toISOString(),
      open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1,
    })),
    currencyCode: 'USD',
    displayPriceDecimals: 2,
  });
  chart.render();
  chart.flushEffects();
  const props = elements(chart.render()).find((element) => element.props.onPan)!.props;
  const adapter = harness.component('CandlestickGestures.web.tsx', props);
  const listeners = new Map();
  const node = {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (name: string, fn: unknown) => { listeners.set(name, fn); },
    removeEventListener: (name: string) => listeners.delete(name),
  };
  adapter.render().props.ref.current = node;
  adapter.flushEffects();
  const geometry = () => elements(chart.render()).find((element) => element.props.geometry)!.props.geometry;
  return { harness, chart, listeners, geometry };
}

describe('long-range 4h chart (577 candles)', () => {
  it('keeps every candle of a 96-day 4h window and opens on the latest ones', () => {
    const h = setup(LONG_RANGE_CANDLES);
    // Nothing is cut below the 1000-candle parser cap: the default window
    // ends exactly at the newest of the 577 candles.
    assert.equal(h.geometry().startIndex, LONG_RANGE_CANDLES - DEFAULT_VISIBLE_CANDLES);
  });

  it('pans back to the oldest candle of the window (no client paging needed)', () => {
    const h = setup(LONG_RANGE_CANDLES);
    for (let step = 0; step < 40; step += 1) {
      (h.listeners.get('pointerdown') as (e: unknown) => void)({
        button: 0, buttons: 1, pointerId: 1, clientX: 0, clientY: 100, preventDefault() {},
      });
      h.harness.windowEvents.get('pointermove')!({
        pointerId: 1, buttons: 1, clientX: 5000, clientY: 100, preventDefault() {},
      });
      h.harness.windowEvents.get('pointerup')!({ pointerId: 1 });
      if (h.geometry().startIndex === 0) break;
    }
    assert.equal(h.geometry().startIndex, 0);
  });
});
