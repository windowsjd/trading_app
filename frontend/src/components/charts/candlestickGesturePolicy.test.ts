import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HORIZONTAL_PAN_SLOP_PX,
  classifyWheelIntent,
  createCrosshairSession,
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

describe('crosshair session', () => {
  function makeSession() {
    const crosshairCalls: ({ x: number; y: number } | null)[] = [];
    let gestureEnds = 0;
    const session = createCrosshairSession({
      onCrosshair: (point) => crosshairCalls.push(point),
      onGestureEnd: () => {
        gestureEnds += 1;
      },
    });
    return {
      session,
      crosshairCalls,
      gestureEnds: () => gestureEnds,
    };
  }

  it('is inactive until a long press starts it', () => {
    const { session, crosshairCalls } = makeSession();
    assert.equal(session.isActive(), false);
    // A plain horizontal pan / vertical swipe never calls start(), so no
    // crosshair appears for either.
    assert.equal(session.move({ x: 10, y: 10 }), false);
    assert.deepEqual(crosshairCalls, []);
  });

  it('shows and moves the crosshair once armed', () => {
    const { session, crosshairCalls } = makeSession();
    session.start({ x: 10, y: 20 });
    assert.equal(session.isActive(), true);
    assert.equal(session.move({ x: 30, y: 40 }), true);
    assert.deepEqual(crosshairCalls, [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it('ends on finalize even when the touch never moved', () => {
    // Long press → lift with no movement: `crosshairPan` never activated, so
    // the long press finalize is the only thing that can clear it.
    const { session, crosshairCalls, gestureEnds } = makeSession();
    session.start({ x: 10, y: 20 });

    assert.equal(session.end(), true);
    assert.equal(session.isActive(), false);
    assert.equal(crosshairCalls.at(-1), null);
    assert.equal(gestureEnds(), 1);
  });

  it('is idempotent, so every recognizer may finalize it', () => {
    // long-press finalize + crosshair-pan finalize both fire for one lift.
    const { session, crosshairCalls, gestureEnds } = makeSession();
    session.start({ x: 10, y: 20 });
    session.end();

    assert.equal(session.end(), false);
    assert.equal(session.end(), false);
    assert.equal(gestureEnds(), 1, 'gesture end reported exactly once');
    assert.equal(
      crosshairCalls.filter((call) => call === null).length,
      1,
      'crosshair cleared exactly once',
    );
  });

  it('drops the crosshair when a pinch takes over', () => {
    const { session, crosshairCalls, gestureEnds } = makeSession();
    session.start({ x: 10, y: 20 });

    // Pinch onBegin ends the crosshair before snapshotting the viewport.
    assert.equal(session.end(), true);
    assert.equal(session.isActive(), false);
    assert.equal(crosshairCalls.at(-1), null);
    assert.equal(gestureEnds(), 1);
    // The pinch's own finalize must not clear a crosshair that is not there.
    assert.equal(session.end(), false);
  });

  it('does nothing on a finalize that follows no long press', () => {
    const { session, crosshairCalls, gestureEnds } = makeSession();
    assert.equal(session.end(), false);
    assert.deepEqual(crosshairCalls, []);
    assert.equal(gestureEnds(), 0);
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
