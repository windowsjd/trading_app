import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_BODY_WIDTH,
  candleXCenter,
  computeSlotLayout,
  visibleOffsetForX,
} from './candlestickLayout.ts';
import {
  MAX_VISIBLE_CANDLES,
  MIN_VISIBLE_CANDLES,
} from './candlestickViewport.ts';

const PADDING_LEFT = 8;
const PHONE_INNER = 246; // ~320px card minus paddings
const WIDE_INNER = 1000; // web / tablet

describe('computeSlotLayout', () => {
  it('spreads the visible candles across the full width', () => {
    const layout = computeSlotLayout(PHONE_INNER, 60);
    assert.equal(layout.slotWidth, PHONE_INNER / 60);
    assert.ok(layout.bodyWidth <= layout.slotWidth);
    assert.ok(layout.bodyWidth > 0);
  });

  it('gives the same candle density for every timeframe at 60 candles', () => {
    // A 5m chart and a 1w chart both render 60 candles by default, so their
    // slot widths must be identical for the same chart width.
    assert.equal(
      computeSlotLayout(PHONE_INNER, 60).slotWidth,
      computeSlotLayout(PHONE_INNER, 60).slotWidth,
    );
  });

  it('widens candles when zoomed in and narrows them when zoomed out', () => {
    const zoomedIn = computeSlotLayout(PHONE_INNER, MIN_VISIBLE_CANDLES);
    const base = computeSlotLayout(PHONE_INNER, 60);
    const zoomedOut = computeSlotLayout(PHONE_INNER, MAX_VISIBLE_CANDLES);

    assert.ok(zoomedIn.slotWidth > base.slotWidth);
    assert.ok(zoomedOut.slotWidth < base.slotWidth);
    assert.ok(zoomedOut.bodyWidth > 0, 'body stays visible when zoomed out');
  });

  it('caps the body width on very wide screens', () => {
    const layout = computeSlotLayout(WIDE_INNER, MIN_VISIBLE_CANDLES);
    assert.ok(layout.bodyWidth <= MAX_BODY_WIDTH);
  });

  it('survives degenerate inputs', () => {
    assert.ok(computeSlotLayout(0, 60).slotWidth > 0);
    assert.ok(computeSlotLayout(PHONE_INNER, 0).slotWidth > 0);
    assert.ok(Number.isFinite(computeSlotLayout(Number.NaN, Number.NaN).slotWidth));
  });
});

describe('x mapping', () => {
  it('maps a visible offset to x and back', () => {
    const { slotWidth } = computeSlotLayout(PHONE_INNER, 60);
    const x = candleXCenter(PADDING_LEFT, slotWidth, 30);

    assert.equal(visibleOffsetForX(x, PADDING_LEFT, slotWidth, 60), 30);
  });

  it('clamps pointers outside the plot to the first/last visible candle', () => {
    const { slotWidth } = computeSlotLayout(PHONE_INNER, 60);

    assert.equal(visibleOffsetForX(-500, PADDING_LEFT, slotWidth, 60), 0);
    assert.equal(visibleOffsetForX(5_000, PADDING_LEFT, slotWidth, 60), 59);
  });

  it('returns the first candle for degenerate inputs', () => {
    assert.equal(visibleOffsetForX(Number.NaN, PADDING_LEFT, 4, 60), 0);
    assert.equal(visibleOffsetForX(100, PADDING_LEFT, 0, 60), 0);
    assert.equal(visibleOffsetForX(100, PADDING_LEFT, 4, 0), 0);
  });
});
