import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceRange, capturePriceScale, scalePriceByPixels, scaledPriceRange, MIN_PRICE_SCALE, MAX_PRICE_SCALE } from './candlestickPriceScale.ts';
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
