import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_BODY_WIDTH,
  candleXCenter,
  computeLeadingEmptySlots,
  computeSlotLayout,
  originalCandleIndexForX,
  visibleOffsetForX,
} from './candlestickLayout.ts';
import {
  MAX_VISIBLE_CANDLES,
  MIN_VISIBLE_CANDLES,
  createDefaultViewport,
  getVisibleIndexRange,
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

/**
 * Short data sets: the viewport still owns 60 slots, so the candles keep the
 * default width and the shortfall becomes empty space on the LEFT.
 */
function shortSetGeometry(total: number, visibleCount = 60) {
  const { slotWidth } = computeSlotLayout(PHONE_INNER, visibleCount);
  const { startIndex, endIndex } = getVisibleIndexRange(total, {
    visibleCount,
    rightOffset: 0,
  });
  return {
    slotWidth,
    startIndex,
    endIndex,
    viewportVisibleCount: visibleCount,
    leadingEmptySlots: computeLeadingEmptySlots(
      visibleCount,
      endIndex - startIndex,
    ),
  };
}

describe('leading empty slots', () => {
  it('counts the slots the data does not fill', () => {
    assert.equal(computeLeadingEmptySlots(60, 40), 20);
    assert.equal(computeLeadingEmptySlots(60, 12), 48);
    assert.equal(computeLeadingEmptySlots(60, 60), 0);
    assert.equal(computeLeadingEmptySlots(20, 12), 8);
  });

  it('is 0 whenever the data fills or overflows the viewport', () => {
    assert.equal(computeLeadingEmptySlots(60, 60), 0);
    assert.equal(computeLeadingEmptySlots(60, 600), 0);
    assert.equal(shortSetGeometry(600).leadingEmptySlots, 0);
  });

  it('is 0 in history, where the window is full of real candles', () => {
    const { visibleCount } = createDefaultViewport(600);
    const { startIndex, endIndex } = getVisibleIndexRange(600, {
      visibleCount,
      rightOffset: 100,
    });
    assert.equal(
      computeLeadingEmptySlots(visibleCount, endIndex - startIndex),
      0,
    );
  });

  it('survives degenerate inputs', () => {
    assert.equal(computeLeadingEmptySlots(Number.NaN, 10), 0);
    assert.equal(computeLeadingEmptySlots(60, Number.NaN), 60);
    assert.equal(computeLeadingEmptySlots(-5, -5), 0);
  });
});

describe('right alignment of short data sets', () => {
  it('gives 40 candles the same width and right edge as 600', () => {
    const short = shortSetGeometry(40);
    const full = shortSetGeometry(600);
    assert.equal(short.slotWidth, full.slotWidth, 'same candle width');

    const lastShortX = candleXCenter(
      PADDING_LEFT,
      short.slotWidth,
      short.leadingEmptySlots + (short.endIndex - 1 - short.startIndex),
    );
    const lastFullX = candleXCenter(
      PADDING_LEFT,
      full.slotWidth,
      full.leadingEmptySlots + (full.endIndex - 1 - full.startIndex),
    );
    assert.equal(lastShortX, lastFullX, 'newest candle at the same right edge');
    assert.ok(lastShortX <= PADDING_LEFT + PHONE_INNER);
  });

  it('starts 40 candles one slot after the 20 empty ones', () => {
    const { slotWidth, leadingEmptySlots } = shortSetGeometry(40);
    assert.equal(leadingEmptySlots, 20);
    assert.equal(
      candleXCenter(PADDING_LEFT, slotWidth, leadingEmptySlots),
      PADDING_LEFT + 20.5 * slotWidth,
    );
  });

  it('pins 12 candles to the right end of the 60 slots', () => {
    const { slotWidth, leadingEmptySlots, startIndex, endIndex } =
      shortSetGeometry(12);
    assert.equal(leadingEmptySlots, 48);
    const lastX = candleXCenter(
      PADDING_LEFT,
      slotWidth,
      leadingEmptySlots + (endIndex - 1 - startIndex),
    );
    assert.equal(lastX, PADDING_LEFT + 59.5 * slotWidth);
    assert.ok(PADDING_LEFT + PHONE_INNER - lastX < slotWidth);
  });

  it('keeps the empty slots on the left after zooming in', () => {
    const { slotWidth, leadingEmptySlots } = shortSetGeometry(12, 20);
    assert.equal(leadingEmptySlots, 8);
    assert.ok(
      slotWidth > computeSlotLayout(PHONE_INNER, 60).slotWidth,
      'zoomed-in candles are wider',
    );
  });
});

describe('originalCandleIndexForX', () => {
  const short = shortSetGeometry(40); // 20 empty slots, indices 0..39

  const indexAtSlot = (slot: number, geometry = short) =>
    originalCandleIndexForX({
      x: candleXCenter(PADDING_LEFT, geometry.slotWidth, slot),
      paddingLeft: PADDING_LEFT,
      slotWidth: geometry.slotWidth,
      viewportVisibleCount: geometry.viewportVisibleCount,
      startIndex: geometry.startIndex,
      endIndex: geometry.endIndex,
      leadingEmptySlots: geometry.leadingEmptySlots,
    });

  it('snaps an empty slot to the first real candle', () => {
    assert.equal(indexAtSlot(0), 0);
    assert.equal(indexAtSlot(10), 0);
    assert.equal(indexAtSlot(19), 0, 'last empty slot');
  });

  it('maps the first and last real candles exactly', () => {
    assert.equal(indexAtSlot(20), 0, 'first real candle');
    assert.equal(indexAtSlot(21), 1);
    assert.equal(indexAtSlot(59), 39, 'newest candle');
  });

  it('never produces an index outside the data', () => {
    for (const x of [-5_000, -1, 0, 123, PADDING_LEFT + PHONE_INNER, 5_000]) {
      const index = originalCandleIndexForX({
        x,
        paddingLeft: PADDING_LEFT,
        slotWidth: short.slotWidth,
        viewportVisibleCount: short.viewportVisibleCount,
        startIndex: short.startIndex,
        endIndex: short.endIndex,
        leadingEmptySlots: short.leadingEmptySlots,
      });
      assert.ok(index >= 0 && index <= 39, `x=${x} → ${index}`);
      assert.ok(Number.isInteger(index));
    }
  });

  it('maps correctly after zooming a short data set', () => {
    const zoomed = shortSetGeometry(12, 20); // 8 empty slots, indices 0..11
    assert.equal(indexAtSlot(0, zoomed), 0, 'empty slot snaps to the first');
    assert.equal(indexAtSlot(8, zoomed), 0);
    assert.equal(indexAtSlot(19, zoomed), 11, 'newest candle');
  });

  it('uses real indices in history, where no slot is empty', () => {
    const { slotWidth } = computeSlotLayout(PHONE_INNER, 60);
    const history = getVisibleIndexRange(600, {
      visibleCount: 60,
      rightOffset: 100,
    });
    const at = (slot: number) =>
      originalCandleIndexForX({
        x: candleXCenter(PADDING_LEFT, slotWidth, slot),
        paddingLeft: PADDING_LEFT,
        slotWidth,
        viewportVisibleCount: 60,
        startIndex: history.startIndex,
        endIndex: history.endIndex,
        leadingEmptySlots: 0,
      });

    assert.equal(at(0), 440);
    assert.equal(at(59), 499);
  });

  it('returns the start index when there is nothing to point at', () => {
    assert.equal(
      originalCandleIndexForX({
        x: 100,
        paddingLeft: PADDING_LEFT,
        slotWidth: 4,
        viewportVisibleCount: 60,
        startIndex: 0,
        endIndex: 0,
        leadingEmptySlots: 60,
      }),
      0,
    );
  });
});
