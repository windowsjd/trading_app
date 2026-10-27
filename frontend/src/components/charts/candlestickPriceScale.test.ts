import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceRange, capturePriceScale, scalePriceByPixels, scaledPriceRange, zoomPriceScale, MIN_PRICE_SCALE, MAX_PRICE_SCALE } from './candlestickPriceScale.ts';
import { classifyTwoFingerGesture } from './candlestickGesturePolicy.ts';

test('manual scale expands/contracts around the same center and clamps', () => {
  const initial = capturePriceScale(priceRange(95, 105));
  for (const dy of [-100000, -100, 0, 100, 100000]) {
    const scale = scalePriceByPixels(initial, dy), range = scaledPriceRange(scale);
    assert.ok(scale.factor >= MIN_PRICE_SCALE && scale.factor <= MAX_PRICE_SCALE);
    assert.ok(Math.abs((range.minY + range.maxY) / 2 - initial.center) < 1e-10);
    assert.equal(range.range > initial.halfRange * 2, dy > 0);
  }
});
test('tiny prices, flat candles, corrupted factors and huge ranges stay finite and positive', () => {
  for (const value of [1e-8, 1e-20, 0, -1, NaN, Infinity, 1e300, 100000]) {
    const initial = capturePriceScale(priceRange(value, value));
    for (const factor of [0, -1, NaN, Infinity, 1e300, 1e-300]) {
      const range = scaledPriceRange({ ...initial, factor });
      assert.ok(range.minY > 0 && range.maxY > range.minY && range.range > 0);
      assert.ok(Object.values(range).every(Number.isFinite));
    }
  }
});
test('two-finger arbitration separates parallel vertical movement, pinch, horizontal motion and jitter', () => {
  const start = [{id: 1, x: 80, y: 100}, {id: 2, x: 180, y: 100}] as const;
  assert.equal(classifyTwoFingerGesture(start, [{id:1,x:81,y:140},{id:2,x:181,y:140}]), 'priceScale');
  assert.equal(classifyTwoFingerGesture(start, [{id:1,x:50,y:140},{id:2,x:210,y:140}]), 'pinch');
  assert.equal(classifyTwoFingerGesture(start, [{id:1,x:110,y:101},{id:2,x:210,y:101}]), null);
  assert.equal(classifyTwoFingerGesture(start, [{id:1,x:80,y:103},{id:2,x:180,y:103}]), null);
  assert.equal(classifyTwoFingerGesture(start, [{id:3,x:80,y:140},{id:2,x:180,y:140}]), null);
});
test('a vertical pinch zooms prices about where it began, within the scale limits, above zero', () => {
  const start = capturePriceScale(priceRange(95, 105));
  const before = scaledPriceRange(start);
  const priceAt = (range: { maxY: number; range: number }, at: number) => range.maxY - at * range.range;
  for (const at of [0, 0.25, 0.5, 1]) for (const scale of [2, 0.5]) {
    const after = scaledPriceRange(zoomPriceScale(start, scale, at));
    assert.ok(Math.abs(after.range - before.range / scale) < 1e-9, 'apart = narrower range, together = wider');
    assert.ok(Math.abs(priceAt(after, at) - priceAt(before, at)) < 1e-9, 'the price under the pinch stays');
  }
  assert.equal(zoomPriceScale(start, 1e6, 0.5).factor, MIN_PRICE_SCALE);
  assert.equal(zoomPriceScale(start, 1e-6, 0.5).factor, MAX_PRICE_SCALE);
  const widest = scaledPriceRange(zoomPriceScale(start, 1e-6, 0));
  assert.ok(widest.minY > 0 && widest.range > before.range && Object.values(widest).every(Number.isFinite));
  // Continues from an earlier zoom (the gesture start), never resets it.
  const twice = zoomPriceScale(zoomPriceScale(start, 2, 0.5), 2, 0.5);
  assert.ok(Math.abs(scaledPriceRange(twice).range - before.range / 4) < 1e-9);
  for (const scale of [0, -1, NaN, Infinity]) assert.equal(zoomPriceScale(start, scale, 0.5) === start, true);
});
test('a pinch zooms the axis its fingers spread along: vertical → prices, horizontal or diagonal → time', () => {
  const vertical = [{ id: 1, x: 150, y: 80 }, { id: 2, x: 150, y: 180 }] as const;
  assert.equal(classifyTwoFingerGesture(vertical, [{ id: 1, x: 151, y: 60 }, { id: 2, x: 149, y: 200 }]), 'priceZoom');
  assert.equal(classifyTwoFingerGesture(vertical, [{ id: 1, x: 150, y: 95 }, { id: 2, x: 150, y: 165 }]), 'priceZoom');
  // About 60° from horizontal still reads as vertical.
  const tilted = [{ id: 1, x: 120, y: 180 }, { id: 2, x: 170, y: 93 }] as const;
  assert.equal(classifyTwoFingerGesture(tilted, [{ id: 1, x: 115, y: 188.7 }, { id: 2, x: 175, y: 84.3 }]), 'priceZoom');
  const horizontal = [{ id: 1, x: 80, y: 100 }, { id: 2, x: 180, y: 100 }] as const;
  assert.equal(classifyTwoFingerGesture(horizontal, [{ id: 1, x: 60, y: 101 }, { id: 2, x: 200, y: 99 }]), 'pinch');
  const diagonal = [{ id: 1, x: 100, y: 200 }, { id: 2, x: 170, y: 130 }] as const;
  assert.equal(classifyTwoFingerGesture(diagonal, [{ id: 1, x: 90, y: 210 }, { id: 2, x: 180, y: 120 }]), 'pinch');
  // A parallel vertical drag is still the drag scale, small moves still wait.
  assert.equal(classifyTwoFingerGesture(vertical, [{ id: 1, x: 150, y: 120 }, { id: 2, x: 150, y: 220 }]), 'priceScale');
  assert.equal(classifyTwoFingerGesture(vertical, [{ id: 1, x: 150, y: 81 }, { id: 2, x: 150, y: 182 }]), null);
});
