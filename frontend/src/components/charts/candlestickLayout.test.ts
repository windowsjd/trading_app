import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  candleIndexForX,
  candleXCenter,
  computeCandleXLayout,
  MAX_BODY_WIDTH,
  MAX_SLOT_WIDTH,
  MIN_SLOT_WIDTH,
  TARGET_VISIBLE_CANDLES,
} from './candlestickLayout.ts';

const PADDING_LEFT = 8;
const PHONE_INNER = 246; // ~320px card minus paddings
const WIDE_INNER = 1000; // web / tablet

function approx(actual: number, expected: number, epsilon = 0.001) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} ≈ ${expected}`,
  );
}

test('computeCandleXLayout invariants across candle counts', async (t) => {
  for (const count of [1, 2, 5, 30, 100]) {
    await t.test(`count=${count}`, () => {
      const layout = computeCandleXLayout(count, PHONE_INNER, PADDING_LEFT);

      // Never over-spread: candles fit within the chart, slot capped.
      assert.ok(layout.plotWidth <= PHONE_INNER + 0.001, 'plot fits inner width');
      assert.ok(layout.slotWidth <= MAX_SLOT_WIDTH + 0.001, 'slot <= max');
      assert.ok(layout.xStart >= PADDING_LEFT - 0.001, 'xStart >= paddingLeft');

      // Body sizing is clamped and never wider than its slot.
      assert.ok(layout.bodyWidth <= layout.slotWidth + 0.001, 'body <= slot');
      assert.ok(layout.bodyWidth <= MAX_BODY_WIDTH + 0.001, 'body <= max body');
      assert.ok(layout.bodyWidth > 0, 'body > 0');

      // Newest candle is pinned to the right edge (minus half a slot),
      // regardless of how many candles there are.
      const lastCenter = candleXCenter(
        layout.xStart,
        layout.slotWidth,
        count - 1,
      );
      approx(lastCenter, PADDING_LEFT + PHONE_INNER - layout.slotWidth / 2);
    });
  }
});

test('sparse data is capped and right-aligned (empty left area)', () => {
  // On a phone width, innerWidth/TARGET is below MIN_SLOT, so the cap = MIN_SLOT.
  for (const count of [1, 2, 5, 30]) {
    const layout = computeCandleXLayout(count, PHONE_INNER, PADDING_LEFT);
    approx(layout.slotWidth, MIN_SLOT_WIDTH);
    assert.ok(
      layout.xStart > PADDING_LEFT,
      `count=${count} should be right-aligned with an empty left area`,
    );
    approx(layout.plotWidth, MIN_SLOT_WIDTH * count);
  }
});

test('dense data fills the full width (no left gap)', () => {
  const count = 100;
  const layout = computeCandleXLayout(count, PHONE_INNER, PADDING_LEFT);
  approx(layout.xStart, PADDING_LEFT); // starts at the left edge
  approx(layout.plotWidth, PHONE_INNER); // spans the whole chart
  approx(layout.slotWidth, PHONE_INNER / count);
});

test('cap scales with a wide screen via TARGET_VISIBLE_CANDLES', () => {
  const layout = computeCandleXLayout(5, WIDE_INNER, PADDING_LEFT);
  const expectedSlot = WIDE_INNER / TARGET_VISIBLE_CANDLES; // ~16.7
  approx(layout.slotWidth, expectedSlot);
  assert.ok(layout.slotWidth > MIN_SLOT_WIDTH, 'wider than phone min');
  assert.ok(layout.slotWidth < MAX_SLOT_WIDTH, 'below max slot');
  assert.ok(layout.xStart > PADDING_LEFT, 'still right-aligned');
});

test('candleIndexForX snaps sensibly', () => {
  const count = 5;
  const layout = computeCandleXLayout(count, PHONE_INNER, PADDING_LEFT);
  const { xStart, slotWidth } = layout;

  // Empty left region → first candle.
  assert.equal(candleIndexForX(xStart, slotWidth, PADDING_LEFT, count), 0);
  assert.equal(candleIndexForX(xStart, slotWidth, xStart - 50, count), 0);

  // First / last candle centers resolve to their own index.
  assert.equal(
    candleIndexForX(xStart, slotWidth, candleXCenter(xStart, slotWidth, 0), count),
    0,
  );
  assert.equal(
    candleIndexForX(
      xStart,
      slotWidth,
      candleXCenter(xStart, slotWidth, count - 1),
      count,
    ),
    count - 1,
  );

  // Far right beyond the plot → last candle.
  assert.equal(candleIndexForX(xStart, slotWidth, 100000, count), count - 1);
});

test('candle centers are strictly increasing', () => {
  const count = 30;
  const layout = computeCandleXLayout(count, PHONE_INNER, PADDING_LEFT);
  let previous = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const center = candleXCenter(layout.xStart, layout.slotWidth, i);
    assert.ok(center > previous, `center[${i}] increases`);
    previous = center;
  }
});
