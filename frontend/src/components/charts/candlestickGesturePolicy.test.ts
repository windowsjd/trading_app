import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HORIZONTAL_PAN_SLOP_PX,
  classifyWheelIntent,
  createChartGestureSession,
  createWheelGestureSession,
  isHorizontalPanIntent,
  isWithinChartBounds,
  pinchScale,
  resolveWheelHandling,
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
  it('zooms on a plain vertical wheel over the chart', () => {
    // The listener only sees wheels that land ON the chart; there the chart
    // owns the wheel, so the page never scrolls under the pointer.
    assert.equal(classifyWheelIntent({ deltaY: -120 }), 'zoom');
    assert.equal(classifyWheelIntent({ deltaY: 120 }), 'zoom');
  });

  it('zooms on ctrl/cmd + wheel (also a trackpad pinch)', () => {
    assert.equal(classifyWheelIntent({ deltaY: -50, ctrlKey: true }), 'zoom');
    assert.equal(classifyWheelIntent({ deltaY: 50, metaKey: true }), 'zoom');
  });

  it('pans on shift + wheel and on horizontal wheels', () => {
    assert.equal(classifyWheelIntent({ deltaY: 50, shiftKey: true }), 'pan');
    assert.equal(classifyWheelIntent({ deltaX: -80, deltaY: 4 }), 'pan');
    // Shift wins over a mostly-vertical delta.
    assert.equal(
      classifyWheelIntent({ deltaX: 2, deltaY: 90, shiftKey: true }),
      'pan',
    );
  });
});

describe('resolveWheelHandling (wheel vs an active mouse drag)', () => {
  const idle = { dragActive: false };
  const dragging = { dragActive: true };

  it('zooms and pans normally while no drag is running', () => {
    assert.equal(resolveWheelHandling({ deltaY: -120 }, idle), 'zoom');
    assert.equal(resolveWheelHandling({ deltaY: 120, ctrlKey: true }, idle), 'zoom');
    assert.equal(resolveWheelHandling({ deltaY: 120, shiftKey: true }, idle), 'pan');
    assert.equal(resolveWheelHandling({ deltaX: -80, deltaY: 4 }, idle), 'pan');
  });

  it('consumes — never zooms or pans — every wheel during a drag', () => {
    // Two gestures writing the viewport at once is the bug; the drag wins.
    assert.equal(resolveWheelHandling({ deltaY: -120 }, dragging), 'consume');
    assert.equal(resolveWheelHandling({ deltaY: 120, ctrlKey: true }, dragging), 'consume');
    assert.equal(resolveWheelHandling({ deltaY: 120, shiftKey: true }, dragging), 'consume');
    assert.equal(resolveWheelHandling({ deltaX: -80, deltaY: 4 }, dragging), 'consume');
    // Consumed still means preventDefault: the page must not scroll mid-drag.
    assert.notEqual(resolveWheelHandling({ deltaY: 120 }, dragging), 'skip');
  });

  it('leaves a no-op wheel completely alone', () => {
    assert.equal(resolveWheelHandling({ deltaX: 0, deltaY: 0 }, idle), 'skip');
    assert.equal(resolveWheelHandling({}, idle), 'skip');
  });

  it('drives the adapter: no wheel session is opened during a drag', () => {
    // Mirrors CandlestickGestures.web: resolve → (skip: return) →
    // preventDefault → (consume: return) → session.
    const events: string[] = [];
    let prevented = 0;
    let dragActive = false;
    const session = createWheelGestureSession({
      onGestureStart: () => events.push('start'),
      onZoom: () => events.push('zoom'),
      onPan: () => events.push('pan'),
      onGestureEnd: () => events.push('end'),
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const wheel = (event: { deltaX?: number; deltaY?: number; shiftKey?: boolean }) => {
      const handling = resolveWheelHandling(event, { dragActive });
      if (handling === 'skip') return;
      prevented += 1;
      if (handling === 'consume') return;
      if (handling === 'zoom') session.zoom(1.2, 100);
      else session.pan(-40);
    };

    // Drag starts: mouse down ends any open wheel session and takes over.
    dragActive = true;
    session.end();
    wheel({ deltaY: -120 });
    wheel({ deltaY: 120, shiftKey: true });

    assert.equal(prevented, 2, 'both mid-drag wheels were consumed');
    assert.deepEqual(events, [], 'no zoom, no pan, no gesture start/end');
    assert.equal(session.isActive(), false, 'no wheel session opened');

    // mouseup → wheels work again, and they accumulate as one burst.
    dragActive = false;
    wheel({ deltaY: -120 });
    wheel({ deltaY: -120 });

    assert.equal(prevented, 4);
    assert.deepEqual(events, ['start', 'zoom', 'zoom'], 'one start, accumulating zooms');
    assert.equal(session.isActive(), true);
  });
});

describe('isWithinChartBounds', () => {
  const box = { width: 300, height: 400 };

  it('accepts points on the chart', () => {
    assert.equal(isWithinChartBounds({ x: 0, y: 0 }, box), true);
    assert.equal(isWithinChartBounds({ x: 150, y: 200 }, box), true);
    assert.equal(isWithinChartBounds({ x: 300, y: 400 }, box), true);
  });

  it('rejects points off the chart in any direction', () => {
    assert.equal(isWithinChartBounds({ x: -1, y: 200 }, box), false);
    assert.equal(isWithinChartBounds({ x: 301, y: 200 }, box), false);
    assert.equal(isWithinChartBounds({ x: 150, y: -1 }, box), false);
    assert.equal(isWithinChartBounds({ x: 150, y: 401 }, box), false);
    assert.equal(isWithinChartBounds({ x: Number.NaN, y: 10 }, box), false);
  });

  it('never cancels when the container size is unknown', () => {
    assert.equal(isWithinChartBounds({ x: 999, y: 999 }, { width: 0, height: 0 }), true);
  });
});

describe('chart gesture lifecycle session', () => {
  function makeSession() {
    const crosshairCalls: ({ x: number; y: number } | null)[] = [];
    let gestureStarts = 0;
    let gestureEnds = 0;
    const session = createChartGestureSession({
      onCrosshair: (point) => crosshairCalls.push(point),
      onGestureStart: () => {
        gestureStarts += 1;
      },
      onGestureEnd: () => {
        gestureEnds += 1;
      },
    });
    return {
      session,
      crosshairCalls,
      gestureStarts: () => gestureStarts,
      gestureEnds: () => gestureEnds,
    };
  }

  it('is idle until a gesture claims it', () => {
    const { session, crosshairCalls, gestureStarts } = makeSession();
    assert.equal(session.owner(), 'none');
    assert.equal(session.isCrosshairActive(), false);
    // A plain swipe never arms the crosshair, so no crosshair appears.
    assert.equal(session.moveCrosshair({ x: 10, y: 10 }), false);
    assert.deepEqual(crosshairCalls, []);
    assert.equal(gestureStarts(), 0);
  });

  it('reports one start and one end for a chart pan', () => {
    const { session, gestureStarts, gestureEnds } = makeSession();
    assert.equal(session.begin('pan'), true);
    assert.equal(session.owner(), 'pan');
    assert.equal(session.end('pan'), true);

    assert.equal(gestureStarts(), 1);
    assert.equal(gestureEnds(), 1);
    assert.equal(session.owner(), 'none');
  });

  it('reports one start and one end for a pinch', () => {
    const { session, gestureStarts, gestureEnds } = makeSession();
    session.takeOver('pinch');
    assert.equal(session.isOwner('pinch'), true);
    session.end('pinch');

    assert.equal(gestureStarts(), 1);
    assert.equal(gestureEnds(), 1);
  });

  it('shows and moves the crosshair once armed', () => {
    const { session, crosshairCalls } = makeSession();
    assert.equal(session.startCrosshair({ x: 10, y: 20 }), true);
    assert.equal(session.isCrosshairActive(), true);
    assert.equal(session.moveCrosshair({ x: 30, y: 40 }), true);
    assert.deepEqual(crosshairCalls, [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it('ends a long press that never moved, exactly once', () => {
    // Long press → lift with no movement: `crosshairPan` never activated, so
    // the long press finalize is the only thing that can clear it.
    const { session, crosshairCalls, gestureEnds } = makeSession();
    session.startCrosshair({ x: 10, y: 20 });

    assert.equal(session.end('crosshair'), true);
    assert.equal(session.isCrosshairActive(), false);
    assert.equal(crosshairCalls.at(-1), null);
    assert.equal(gestureEnds(), 1);
  });

  it('ends once when long press AND crosshair pan both finalize', () => {
    const { session, crosshairCalls, gestureEnds } = makeSession();
    session.startCrosshair({ x: 10, y: 20 });
    session.end('crosshair');

    // The second recognizer's finalize is ignored.
    assert.equal(session.end('crosshair'), false);
    assert.equal(gestureEnds(), 1, 'gesture end reported exactly once');
    assert.equal(
      crosshairCalls.filter((call) => call === null).length,
      1,
      'crosshair cleared exactly once',
    );
  });

  it('ends the crosshair when the touch leaves the chart, and stays ended', () => {
    const { session, crosshairCalls, gestureEnds } = makeSession();
    const box = { width: 300, height: 400 };
    session.startCrosshair({ x: 100, y: 100 });

    const outside = { x: 100, y: 460 };
    assert.equal(isWithinChartBounds(outside, box), false);
    session.end('crosshair');

    assert.equal(session.isCrosshairActive(), false);
    assert.equal(crosshairCalls.at(-1), null);
    // Coming back inside must NOT revive the finished crosshair session.
    assert.equal(session.moveCrosshair({ x: 120, y: 100 }), false);
    assert.equal(crosshairCalls.at(-1), null);
    assert.equal(gestureEnds(), 1);

    // A brand new long press still works.
    assert.equal(session.startCrosshair({ x: 130, y: 90 }), true);
    assert.deepEqual(crosshairCalls.at(-1), { x: 130, y: 90 });
  });

  it('hands the crosshair over to a pinch in order, without a double end', () => {
    const { session, crosshairCalls, gestureStarts, gestureEnds } = makeSession();
    session.startCrosshair({ x: 10, y: 20 });

    // crosshair end → pinch start
    assert.equal(session.takeOver('pinch'), true);
    assert.equal(session.owner(), 'pinch');
    assert.equal(crosshairCalls.at(-1), null, 'crosshair cleared by the pinch');
    assert.equal(gestureStarts(), 2);
    assert.equal(gestureEnds(), 1);

    // The long press / crosshair pan finalize that follows changes nothing.
    assert.equal(session.end('crosshair'), false);
    assert.equal(session.owner(), 'pinch');
    assert.equal(gestureEnds(), 1);

    session.end('pinch');
    assert.equal(gestureStarts(), 2);
    assert.equal(gestureEnds(), 2);
    assert.equal(session.owner(), 'none');
  });

  it('ignores finalize from a recognizer that never owned the chart', () => {
    const { session, crosshairCalls, gestureStarts, gestureEnds } = makeSession();
    session.startCrosshair({ x: 10, y: 20 });

    // chartPan finalizes while the crosshair owns the session: no end, and the
    // crosshair keeps working.
    assert.equal(session.end('pan'), false);
    assert.equal(session.isCrosshairActive(), true);
    assert.equal(session.moveCrosshair({ x: 40, y: 20 }), true);
    assert.equal(gestureEnds(), 0);

    // A pan cannot start on top of the crosshair either.
    assert.equal(session.begin('pan'), false);
    assert.equal(gestureStarts(), 1);
    assert.equal(session.owner(), 'crosshair');

    session.end('crosshair');
    assert.equal(gestureEnds(), 1);
    // Stray finalizes after everything ended stay inert.
    assert.equal(session.end('pan'), false);
    assert.equal(session.end('pinch'), false);
    assert.equal(session.end('crosshair'), false);
    assert.equal(gestureEnds(), 1);
    assert.equal(crosshairCalls.filter((call) => call === null).length, 1);
  });

  it('does nothing on a finalize that follows no gesture at all', () => {
    const { session, crosshairCalls, gestureStarts, gestureEnds } = makeSession();
    assert.equal(session.end('crosshair'), false);
    assert.deepEqual(crosshairCalls, []);
    assert.equal(gestureStarts(), 0);
    assert.equal(gestureEnds(), 0);
  });
});

describe('wheel gesture session', () => {
  function makeWheelSession(idleMs = 120) {
    const zooms: { scale: number; focalX: number }[] = [];
    const pans: number[] = [];
    let starts = 0;
    let ends = 0;
    let pending: (() => void) | null = null;
    let timerId = 0;
    let clearedTimers = 0;

    const session = createWheelGestureSession({
      onGestureStart: () => {
        starts += 1;
      },
      onZoom: (scale, focalX) => zooms.push({ scale, focalX }),
      onPan: (translationX) => pans.push(translationX),
      onGestureEnd: () => {
        ends += 1;
      },
      idleMs,
      setTimer: (callback) => {
        pending = callback;
        timerId += 1;
        return timerId;
      },
      clearTimer: () => {
        clearedTimers += 1;
        pending = null;
      },
    });

    return {
      session,
      zooms,
      pans,
      starts: () => starts,
      ends: () => ends,
      hasPendingTimer: () => pending !== null,
      clearedTimers: () => clearedTimers,
      fireIdleTimer: () => {
        const callback = pending;
        pending = null;
        callback?.();
      },
    };
  }

  it('treats a wheel burst as ONE gesture and accumulates the zoom', () => {
    const w = makeWheelSession();
    // Three notches in one burst: the chart snapshots its viewport once, so
    // the reported scale must compound instead of repeating one step.
    w.session.zoom(1.2, 100);
    w.session.zoom(1.2, 100);
    w.session.zoom(1.2, 100);

    assert.equal(w.starts(), 1, 'one gesture start for the whole burst');
    assert.equal(w.ends(), 0, 'still open while the wheel keeps firing');
    assert.equal(w.zooms.length, 3);
    assert.ok(w.zooms[1].scale > w.zooms[0].scale);
    assert.ok(Math.abs(w.zooms[2].scale - 1.2 ** 3) < 1e-9);
    assert.equal(w.zooms[2].focalX, 100);
  });

  it('closes the session after the idle gap, then starts a new one', () => {
    const w = makeWheelSession();
    w.session.zoom(1.2, 100);
    assert.equal(w.session.isActive(), true);

    w.fireIdleTimer();
    assert.equal(w.ends(), 1);
    assert.equal(w.session.isActive(), false);

    // The next burst zooms from the NEW snapshot, not the old accumulation.
    w.session.zoom(1.2, 100);
    assert.equal(w.starts(), 2);
    assert.ok(Math.abs(w.zooms.at(-1)!.scale - 1.2) < 1e-9);
  });

  it('accumulates pan pixels and switches mode with a clean end/start', () => {
    const w = makeWheelSession();
    w.session.pan(-40);
    w.session.pan(-40);
    assert.deepEqual(w.pans, [-40, -80]);
    assert.equal(w.starts(), 1);

    w.session.zoom(1.2, 50);
    assert.equal(w.ends(), 1, 'pan session closed');
    assert.equal(w.starts(), 2, 'zoom session opened');
    assert.ok(Math.abs(w.zooms[0].scale - 1.2) < 1e-9);
  });

  it('clears the pending idle timer on dispose without emitting callbacks', () => {
    const w = makeWheelSession();
    w.session.zoom(1.2, 100);
    assert.equal(w.hasPendingTimer(), true);

    w.session.dispose();
    assert.equal(w.hasPendingTimer(), false, 'timer cleared on unmount');
    assert.ok(w.clearedTimers() >= 1);
    assert.equal(w.ends(), 0, 'no callback after unmount');
    assert.equal(w.session.isActive(), false);
  });

  it('ignores invalid wheel input', () => {
    const w = makeWheelSession();
    w.session.zoom(Number.NaN, 100);
    w.session.pan(Number.NaN);
    assert.equal(w.starts(), 0);
    assert.deepEqual(w.zooms, []);
    assert.deepEqual(w.pans, []);
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
