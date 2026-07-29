import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MOBILE_CHART_MAX_HEIGHT,
  MOBILE_CHART_MIN_HEIGHT,
  WIDE_CHART_MAX_HEIGHT,
  WIDE_CHART_MIN_HEIGHT,
  WIDE_LAYOUT_MIN_WIDTH,
  getCandlestickChartHeight,
} from './candlestickChartHeight.ts';

describe('getCandlestickChartHeight', () => {
  it('is far taller than the old fixed 240px strip on any phone', () => {
    // The regression this policy exists to prevent.
    assert.ok(getCandlestickChartHeight(320, 568) > 240);
    assert.ok(getCandlestickChartHeight(390, 844) > 240);
    assert.ok(getCandlestickChartHeight(1440, 900) > 240);
  });

  it('takes ~52% of the window on a phone', () => {
    // iPhone 14-ish: 844 * 0.52 = 438.9
    assert.equal(getCandlestickChartHeight(390, 844), 439);
    // Pixel-ish 412 x 915: 915 * 0.52 = 475.8
    assert.equal(getCandlestickChartHeight(412, 915), 476);
  });

  it('clamps a small phone to the 380 floor', () => {
    // 568 * 0.52 = 295.4 → floor.
    assert.equal(getCandlestickChartHeight(320, 568), MOBILE_CHART_MIN_HEIGHT);
  });

  it('clamps a very tall phone to the 480 ceiling', () => {
    // 1200 * 0.52 = 624 → ceiling.
    assert.equal(getCandlestickChartHeight(414, 1200), MOBILE_CHART_MAX_HEIGHT);
  });

  it('takes ~60% of the window on a wide/tablet layout', () => {
    // 1080 * 0.6 = 648
    assert.equal(getCandlestickChartHeight(1440, 1080), 648);
    // 900 * 0.6 = 540
    assert.equal(getCandlestickChartHeight(1024, 900), 540);
  });

  it('clamps a short desktop window to the 500 floor', () => {
    // 800 * 0.6 = 480 → floor.
    assert.equal(getCandlestickChartHeight(1280, 800), WIDE_CHART_MIN_HEIGHT);
  });

  it('clamps a very tall desktop window to the 680 ceiling', () => {
    // 1600 * 0.6 = 960 → ceiling.
    assert.equal(getCandlestickChartHeight(1920, 1600), WIDE_CHART_MAX_HEIGHT);
  });

  it('switches layout class exactly at 768px width', () => {
    const narrow = getCandlestickChartHeight(WIDE_LAYOUT_MIN_WIDTH - 1, 1000);
    const wide = getCandlestickChartHeight(WIDE_LAYOUT_MIN_WIDTH, 1000);

    assert.equal(narrow, MOBILE_CHART_MAX_HEIGHT); // 1000 * 0.52 = 520 → 480
    assert.equal(wide, 600); // 1000 * 0.6
    assert.ok(wide > narrow);
  });

  it('stays inside its bounds across a rotation / resize sweep', () => {
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [844, 390],
      [768, 1024],
      [1024, 768],
      [1920, 1080],
    ] as const) {
      const value = getCandlestickChartHeight(width, height);
      const wide = width >= WIDE_LAYOUT_MIN_WIDTH;
      assert.ok(
        value >= (wide ? WIDE_CHART_MIN_HEIGHT : MOBILE_CHART_MIN_HEIGHT) &&
          value <= (wide ? WIDE_CHART_MAX_HEIGHT : MOBILE_CHART_MAX_HEIGHT),
        `${width}x${height} → ${value}`,
      );
    }
  });

  it('falls back to the class minimum for unusable window dimensions', () => {
    assert.equal(getCandlestickChartHeight(390, 0), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(getCandlestickChartHeight(390, -100), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(
      getCandlestickChartHeight(390, Number.NaN),
      MOBILE_CHART_MIN_HEIGHT,
    );
    assert.equal(
      getCandlestickChartHeight(Number.NaN, Number.NaN),
      MOBILE_CHART_MIN_HEIGHT,
    );
    assert.equal(
      getCandlestickChartHeight(1440, Number.POSITIVE_INFINITY),
      WIDE_CHART_MIN_HEIGHT,
    );
  });
});
