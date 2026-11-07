import assert from 'node:assert/strict';
import { it } from 'node:test';
import { clampTickerIndex, nextTickerIndex, tickerDisplayIndex, tickerShouldRotate, TICKER_INTERVAL_MS, TICKER_SHIFT, TICKER_TRANSITION_MS } from './tickerRotation.ts';

it('rotates every 4 s over 450 ms only while Home is shown, the app active, untouched and motion allowed', () => {
  assert.deepEqual([TICKER_INTERVAL_MS, TICKER_TRANSITION_MS, TICKER_SHIFT], [4000, 450, 10]);
  const base = { count: 3, focused: true, appActive: true, pressed: false, reducedMotion: false };
  assert.equal(tickerShouldRotate(base), true);
  for (const pause of [{ count: 1 }, { count: 0 }, { focused: false }, { appActive: false }, { pressed: true }, { reducedMotion: true }]) {
    assert.equal(tickerShouldRotate({ ...base, ...pause }), false, JSON.stringify(pause));
  }
});

it('wraps, clamps a shrunken list and pins the first post under Reduce Motion', () => {
  assert.deepEqual([nextTickerIndex(0, 3), nextTickerIndex(2, 3), nextTickerIndex(5, 2), nextTickerIndex(0, 0)], [1, 0, 1, 0]);
  assert.deepEqual([clampTickerIndex(2, 3), clampTickerIndex(2, 2), clampTickerIndex(-1, 3)], [2, 0, 0]);
  assert.deepEqual([tickerDisplayIndex(2, 3, true), tickerDisplayIndex(2, 3, false)], [0, 2]);
});
