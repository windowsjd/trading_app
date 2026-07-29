import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MOBILE_CHART_MAX_HEIGHT,
  MOBILE_CHART_MIN_HEIGHT,
  NATIVE_TABLET_MIN_SHORT_SIDE,
  WIDE_CHART_MAX_HEIGHT,
  WIDE_CHART_MIN_HEIGHT,
  WIDE_LAYOUT_MIN_WIDTH,
  getCandlestickChartHeight,
  getCandlestickChartLayoutClass,
  toChartLayoutPlatform,
} from './candlestickChartHeight.ts';

const layoutClass = (
  windowWidth: number,
  windowHeight: number,
  platform: 'ios' | 'android' | 'web' | 'unknown',
) => getCandlestickChartLayoutClass({ windowWidth, windowHeight, platform });

const height = (
  windowWidth: number,
  windowHeight: number,
  platform: 'ios' | 'android' | 'web' | 'unknown',
) => getCandlestickChartHeight({ windowWidth, windowHeight, platform });

describe('layout class: native devices are judged by their SHORT side', () => {
  it('keeps an iOS phone a phone in both orientations', () => {
    assert.equal(layoutClass(390, 844, 'ios'), 'phone');
    assert.equal(layoutClass(844, 390, 'ios'), 'phone');
  });

  it('keeps an Android phone a phone in both orientations', () => {
    assert.equal(layoutClass(412, 915, 'android'), 'phone');
    assert.equal(layoutClass(915, 412, 'android'), 'phone');
  });

  it('keeps a tablet a tablet in both orientations', () => {
    assert.equal(layoutClass(768, 1024, 'ios'), 'tablet');
    assert.equal(layoutClass(1024, 768, 'ios'), 'tablet');
  });

  it('switches at a 600px short side', () => {
    assert.equal(layoutClass(599, 1200, 'android'), 'phone');
    assert.equal(layoutClass(1200, 599, 'android'), 'phone');
    assert.equal(layoutClass(NATIVE_TABLET_MIN_SHORT_SIDE, 1200, 'android'), 'tablet');
    assert.equal(layoutClass(1200, NATIVE_TABLET_MIN_SHORT_SIDE, 'android'), 'tablet');
  });

  it('never changes class when the same device rotates', () => {
    for (const [width, height_] of [
      [390, 844],
      [412, 915],
      [430, 932],
      [768, 1024],
      [1024, 1366],
    ] as const) {
      for (const platform of ['ios', 'android', 'unknown'] as const) {
        assert.equal(
          layoutClass(width, height_, platform),
          layoutClass(height_, width, platform),
          `${width}x${height_} on ${platform} must survive rotation`,
        );
      }
    }
  });
});

describe('layout class: web keeps the window-width rule', () => {
  it('classifies by window width, which IS the web layout', () => {
    assert.equal(layoutClass(390, 844, 'web'), 'webNarrow');
    // A 844px-wide browser window really is a wide layout, unlike a landscape
    // phone whose whole screen is 844 x 390.
    assert.equal(layoutClass(844, 390, 'web'), 'webWide');
    assert.equal(layoutClass(1440, 900, 'web'), 'webWide');
  });

  it('switches exactly at 768px width', () => {
    assert.equal(layoutClass(WIDE_LAYOUT_MIN_WIDTH - 1, 1000, 'web'), 'webNarrow');
    assert.equal(layoutClass(WIDE_LAYOUT_MIN_WIDTH, 1000, 'web'), 'webWide');
  });

  it('maps Platform.OS onto the policy platforms', () => {
    assert.equal(toChartLayoutPlatform('web'), 'web');
    assert.equal(toChartLayoutPlatform('ios'), 'ios');
    assert.equal(toChartLayoutPlatform('android'), 'android');
    // Desktop RN targets fall back to the native (short-side) rule.
    assert.equal(toChartLayoutPlatform('macos'), 'unknown');
    assert.equal(toChartLayoutPlatform(undefined), 'unknown');
  });
});

describe('getCandlestickChartHeight', () => {
  it('is far taller than the old fixed 240px strip', () => {
    assert.ok(height(320, 568, 'ios') > 240);
    assert.ok(height(390, 844, 'ios') > 240);
    assert.ok(height(1440, 900, 'web') > 240);
  });

  it('takes ~52% of the window on a phone', () => {
    // 844 * 0.52 = 438.9
    assert.equal(height(390, 844, 'ios'), 439);
    // 915 * 0.52 = 475.8
    assert.equal(height(412, 915, 'android'), 476);
  });

  it('gives a LANDSCAPE phone the phone height, not the 500px wide one', () => {
    // The regression this policy exists to prevent: 390 * 0.52 = 203 → the
    // 380 phone floor. A 500px chart inside a 390px window would be absurd.
    assert.equal(height(844, 390, 'ios'), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(height(915, 412, 'android'), MOBILE_CHART_MIN_HEIGHT);
    assert.notEqual(height(844, 390, 'ios'), WIDE_CHART_MIN_HEIGHT);
  });

  it('clamps phones to 380–480 in every orientation', () => {
    for (const [width, height_] of [
      [320, 568],
      [390, 844],
      [844, 390],
      [412, 915],
      [915, 412],
      [414, 1200],
    ] as const) {
      const value = height(width, height_, 'ios');
      assert.ok(
        value >= MOBILE_CHART_MIN_HEIGHT && value <= MOBILE_CHART_MAX_HEIGHT,
        `${width}x${height_} → ${value}`,
      );
    }
    // 568 * 0.52 = 295 → floor, 1200 * 0.52 = 624 → ceiling.
    assert.equal(height(320, 568, 'ios'), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(height(414, 1200, 'ios'), MOBILE_CHART_MAX_HEIGHT);
  });

  it('gives tablets and wide web the 500–680 policy', () => {
    // 1024 * 0.6 = 614.4
    assert.equal(height(768, 1024, 'ios'), 614);
    // Landscape tablet: 768 * 0.6 = 460.8 → the 500 floor.
    assert.equal(height(1024, 768, 'ios'), WIDE_CHART_MIN_HEIGHT);
    // 1080 * 0.6 = 648
    assert.equal(height(1440, 1080, 'web'), 648);
    // 800 * 0.6 = 480 → floor; 1600 * 0.6 = 960 → ceiling.
    assert.equal(height(1280, 800, 'web'), WIDE_CHART_MIN_HEIGHT);
    assert.equal(height(1920, 1600, 'web'), WIDE_CHART_MAX_HEIGHT);
    for (const [width, height_] of [
      [768, 1024],
      [1024, 768],
      [1440, 900],
      [1920, 1600],
    ] as const) {
      const value = height(width, height_, 'web');
      assert.ok(
        value >= WIDE_CHART_MIN_HEIGHT && value <= WIDE_CHART_MAX_HEIGHT,
        `${width}x${height_} → ${value}`,
      );
    }
  });

  it('gives a narrow web window the phone policy', () => {
    assert.equal(height(390, 844, 'web'), 439);
    assert.equal(height(WIDE_LAYOUT_MIN_WIDTH - 1, 1000, 'web'), MOBILE_CHART_MAX_HEIGHT);
    assert.equal(height(WIDE_LAYOUT_MIN_WIDTH, 1000, 'web'), 600);
  });

  it('falls back to the class minimum for unusable window dimensions', () => {
    assert.equal(height(390, 0, 'ios'), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(height(390, -100, 'ios'), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(height(390, Number.NaN, 'ios'), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(height(Number.NaN, Number.NaN, 'ios'), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(height(Number.NaN, Number.NaN, 'web'), MOBILE_CHART_MIN_HEIGHT);
    assert.equal(height(1440, Number.POSITIVE_INFINITY, 'web'), WIDE_CHART_MIN_HEIGHT);
    // An unusable side never promotes a phone to the tablet policy.
    assert.equal(layoutClass(Number.NaN, 390, 'ios'), 'phone');
    assert.equal(layoutClass(0, 0, 'android'), 'phone');
  });
});
