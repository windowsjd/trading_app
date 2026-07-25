import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HORIZONTAL_PAN_SLOP_PX,
  classifyWheelIntent,
  isHorizontalPanIntent,
  pinchScale,
  wheelZoomScale,
} from './candlestickGesturePolicy.ts';

describe('isHorizontalPanIntent', () => {
  it('claims clearly horizontal drags', () => {
    assert.equal(isHorizontalPanIntent(20, 2), true);
    assert.equal(isHorizontalPanIntent(-20, 2), true);
  });

  it('leaves vertical drags to the parent ScrollView', () => {
    assert.equal(isHorizontalPanIntent(20, 30), false);
    assert.equal(isHorizontalPanIntent(2, 40), false);
  });

  it('ignores small tremors below the slop', () => {
    assert.equal(isHorizontalPanIntent(HORIZONTAL_PAN_SLOP_PX - 1, 0), false);
    assert.equal(isHorizontalPanIntent(0, 0), false);
  });

  it('is safe with non-finite input', () => {
    assert.equal(isHorizontalPanIntent(Number.NaN, 0), false);
  });
});

describe('classifyWheelIntent', () => {
  it('zooms on ctrl/cmd + wheel (also a trackpad pinch)', () => {
    assert.equal(classifyWheelIntent({ deltaY: -50, ctrlKey: true }), 'zoom');
    assert.equal(classifyWheelIntent({ deltaY: 50, metaKey: true }), 'zoom');
  });

  it('pans on shift + wheel and on horizontal wheels', () => {
    assert.equal(classifyWheelIntent({ deltaY: 50, shiftKey: true }), 'pan');
    assert.equal(classifyWheelIntent({ deltaX: -80, deltaY: 4 }), 'pan');
  });

  it('leaves a plain vertical wheel to the page', () => {
    assert.equal(classifyWheelIntent({ deltaY: 120 }), 'page-scroll');
    assert.equal(classifyWheelIntent({ deltaY: -120 }), 'page-scroll');
  });
});

describe('zoom scales', () => {
  it('maps wheel deltas to bounded factors', () => {
    assert.ok(wheelZoomScale(-100) > 1);
    assert.ok(wheelZoomScale(100) < 1);
    assert.equal(wheelZoomScale(0), 1);
    assert.ok(wheelZoomScale(-100_000) <= 2.5);
    assert.ok(wheelZoomScale(100_000) >= 0.4);
  });

  it('maps pinch distance ratios to bounded factors', () => {
    assert.equal(pinchScale(200, 100), 2);
    assert.equal(pinchScale(50, 100), 0.5);
    assert.equal(pinchScale(100, 0), 1);
    assert.ok(pinchScale(100_000, 1) <= 5);
  });
});
