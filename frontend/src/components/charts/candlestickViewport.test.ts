import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BUFFER_CANDLES,
  DEFAULT_VISIBLE_CANDLES,
  MAX_VISIBLE_CANDLES,
  MIN_VISIBLE_CANDLES,
  adjustViewportForDataChange,
  clampRightOffset,
  clampVisibleCount,
  createDefaultViewport,
  getRenderIndexRange,
  getVisibleIndexRange,
  isDefaultViewport,
  isViewingLatest,
  panViewportByPixels,
  resetViewport,
  zoomViewportAtFocalPoint,
} from './candlestickViewport.ts';
import * as viewportModule from './candlestickViewport.ts';

const SLOT = 5; // px per candle at 300px inner width / 60 candles

describe('default viewport', () => {
  it('shows the latest 60 candles for a 600-candle data set', () => {
    const viewport = createDefaultViewport(600);
    assert.equal(viewport.visibleCount, DEFAULT_VISIBLE_CANDLES);
    assert.equal(viewport.rightOffset, 0);

    const { startIndex, endIndex } = getVisibleIndexRange(600, viewport);
    assert.equal(startIndex, 540);
    assert.equal(endIndex, 600);
  });

  it('keeps the 60-slot default when fewer candles exist', () => {
    // The slot count is what fixes the candle WIDTH, so a 40-candle timeframe
    // must open with the same 60 slots as a 600-candle one.
    for (const total of [60, 40, 12, 1]) {
      const viewport = createDefaultViewport(total);
      assert.equal(
        viewport.visibleCount,
        DEFAULT_VISIBLE_CANDLES,
        `total=${total}`,
      );
      assert.equal(viewport.rightOffset, 0, `total=${total}`);
      // …while the index range still covers only the candles that exist.
      assert.deepEqual(getVisibleIndexRange(total, viewport), {
        startIndex: 0,
        endIndex: total,
      });
    }
  });

  it('collapses only when there is no data at all', () => {
    assert.deepEqual(createDefaultViewport(0), {
      visibleCount: 0,
      rightOffset: 0,
    });
    assert.deepEqual(getVisibleIndexRange(0, createDefaultViewport(0)), {
      startIndex: 0,
      endIndex: 0,
    });
  });

  it('ends at the newest candle and reports latest', () => {
    const viewport = createDefaultViewport(600);
    assert.equal(getVisibleIndexRange(600, viewport).endIndex, 600);
    assert.equal(isViewingLatest(viewport), true);
    assert.equal(isViewingLatest({ visibleCount: 60, rightOffset: 30 }), false);
  });

  it('resetViewport returns the default window', () => {
    assert.deepEqual(resetViewport(600), { visibleCount: 60, rightOffset: 0 });
    assert.deepEqual(resetViewport(12), { visibleCount: 60, rightOffset: 0 });
    assert.deepEqual(resetViewport(0), { visibleCount: 0, rightOffset: 0 });
  });
});

describe('pan', () => {
  it('dragging right moves towards older candles', () => {
    const start = createDefaultViewport(600);
    const panned = panViewportByPixels(start, 10 * SLOT, SLOT, 600);

    assert.equal(panned.rightOffset, 10);
    assert.deepEqual(getVisibleIndexRange(600, panned), {
      startIndex: 530,
      endIndex: 590,
    });
  });

  it('dragging left moves back towards the latest candle', () => {
    const history = { visibleCount: 60, rightOffset: 100 };
    const panned = panViewportByPixels(history, -20 * SLOT, SLOT, 600);

    assert.equal(panned.rightOffset, 80);
  });

  it('cannot pan past the newest candle', () => {
    const start = createDefaultViewport(600);
    const panned = panViewportByPixels(start, -10_000, SLOT, 600);

    assert.equal(panned.rightOffset, 0);
    assert.equal(isViewingLatest(panned), true);
  });

  it('cannot pan before the oldest candle', () => {
    const start = createDefaultViewport(600);
    const panned = panViewportByPixels(start, 10_000, SLOT, 600);

    assert.equal(panned.rightOffset, 600 - 60);
    assert.equal(getVisibleIndexRange(600, panned).startIndex, 0);
  });

  it('cannot pan at all when everything already fits', () => {
    for (const total of [40, 12, 60]) {
      const viewport = createDefaultViewport(total);
      assert.equal(
        panViewportByPixels(viewport, 500, SLOT, total).rightOffset,
        0,
        `total=${total}`,
      );
      assert.equal(
        panViewportByPixels(viewport, -500, SLOT, total).rightOffset,
        0,
        `total=${total}`,
      );
    }
  });

  it('ignores unusable pan inputs', () => {
    const viewport = createDefaultViewport(600);
    assert.deepEqual(panViewportByPixels(viewport, Number.NaN, SLOT, 600), viewport);
    assert.deepEqual(panViewportByPixels(viewport, 50, 0, 600), viewport);
  });
});

describe('zoom', () => {
  it('zooming in shows fewer candles, zooming out shows more', () => {
    const start = createDefaultViewport(600);
    const zoomedIn = zoomViewportAtFocalPoint(start, 2, 150, 300, 600);
    const zoomedOut = zoomViewportAtFocalPoint(start, 0.5, 150, 300, 600);

    assert.equal(zoomedIn.visibleCount, 30);
    assert.equal(zoomedOut.visibleCount, 120);
  });

  it('never zooms in past the minimum', () => {
    const start = createDefaultViewport(600);
    const zoomed = zoomViewportAtFocalPoint(start, 100, 150, 300, 600);
    assert.equal(zoomed.visibleCount, MIN_VISIBLE_CANDLES);
  });

  it('never zooms out past the maximum', () => {
    const start = createDefaultViewport(600);
    const zoomed = zoomViewportAtFocalPoint(start, 0.01, 150, 300, 600);
    assert.equal(zoomed.visibleCount, MAX_VISIBLE_CANDLES);
  });

  it('keeps the centre candle in place when zooming at the centre', () => {
    const start = { visibleCount: 60, rightOffset: 100 };
    const before = getVisibleIndexRange(600, start);
    const centreBefore = (before.startIndex + before.endIndex) / 2;

    const zoomed = zoomViewportAtFocalPoint(start, 2, 150, 300, 600);
    const after = getVisibleIndexRange(600, zoomed);
    const centreAfter = (after.startIndex + after.endIndex) / 2;

    assert.ok(
      Math.abs(centreAfter - centreBefore) <= 1,
      `centre moved from ${centreBefore} to ${centreAfter}`,
    );
  });

  it('keeps the newest candle pinned when zooming at the right edge', () => {
    const start = createDefaultViewport(600);
    const zoomed = zoomViewportAtFocalPoint(start, 2, 300, 300, 600);

    assert.equal(zoomed.rightOffset, 0);
    assert.equal(getVisibleIndexRange(600, zoomed).endIndex, 600);
  });

  it('does not jump to the latest when zooming inside history', () => {
    const history = { visibleCount: 60, rightOffset: 300 };
    const zoomed = zoomViewportAtFocalPoint(history, 2, 150, 300, 600);

    assert.ok(zoomed.rightOffset > 0, 'still in history');
    assert.ok(Math.abs(zoomed.rightOffset - 315) <= 2);
  });

  it('zooms a short data set by SLOTS, never by candle count', () => {
    // 12 candles: zooming in widens them (fewer slots) but the data still ends
    // at the right edge, and zooming out is bounded by the slot ceiling.
    const viewport = createDefaultViewport(12);
    const zoomedIn = zoomViewportAtFocalPoint(viewport, 3, 300, 300, 12);
    const zoomedOut = zoomViewportAtFocalPoint(viewport, 0.01, 150, 300, 12);

    assert.equal(zoomedIn.visibleCount, 20);
    assert.equal(zoomedIn.rightOffset, 0);
    assert.deepEqual(getVisibleIndexRange(12, zoomedIn), {
      startIndex: 0,
      endIndex: 12,
    });
    assert.equal(zoomedOut.visibleCount, MAX_VISIBLE_CANDLES);
    assert.equal(zoomedOut.rightOffset, 0);
  });

  it('zooms only through a focal point — there are no zoom step controls', () => {
    // Zoom is pinch (native) / wheel (web) only; nothing in the app may zoom
    // by pressing a button, so this module exposes no step helper.
    assert.equal(
      (viewportModule as Record<string, unknown>).zoomViewportByStep,
      undefined,
    );
    assert.equal(
      (viewportModule as Record<string, unknown>).ZOOM_STEP_SCALE,
      undefined,
    );
  });
});

describe('isDefaultViewport (the "최신" reset affordance)', () => {
  it('is true for the default window on any data length', () => {
    assert.equal(isDefaultViewport(createDefaultViewport(600), 600), true);
    assert.equal(isDefaultViewport(createDefaultViewport(12), 12), true);
    assert.equal(isDefaultViewport({ visibleCount: 60, rightOffset: 0 }, 600), true);
  });

  it('is false in history or at a non-default zoom', () => {
    assert.equal(isDefaultViewport({ visibleCount: 60, rightOffset: 30 }, 600), false);
    assert.equal(isDefaultViewport({ visibleCount: 25, rightOffset: 0 }, 600), false);
    assert.equal(isDefaultViewport({ visibleCount: 180, rightOffset: 0 }, 600), false);
  });

  it('resetting from any state returns the default window', () => {
    // What the "최신" button does: 60 slots, pinned to the newest candle.
    const reset = resetViewport(600);
    assert.equal(reset.visibleCount, DEFAULT_VISIBLE_CANDLES);
    assert.equal(reset.rightOffset, 0);
    assert.equal(isDefaultViewport(reset, 600), true);
    assert.equal(isViewingLatest(reset), true);
  });
});

describe('clamps and invalid input', () => {
  it('clampVisibleCount bounds SLOTS, not the amount of data', () => {
    assert.equal(clampVisibleCount(5, 600), MIN_VISIBLE_CANDLES);
    assert.equal(clampVisibleCount(1000, 600), MAX_VISIBLE_CANDLES);
    // A short data set does not shrink the slot count (that is what used to
    // make 12-candle charts render absurdly fat candles).
    assert.equal(clampVisibleCount(1000, 40), MAX_VISIBLE_CANDLES);
    assert.equal(clampVisibleCount(30, 10), 30);
    assert.equal(clampVisibleCount(60, 1), 60);
  });

  it('handles NaN, zero and negative inputs safely', () => {
    assert.equal(clampVisibleCount(Number.NaN, 600), DEFAULT_VISIBLE_CANDLES);
    assert.equal(clampVisibleCount(-10, 600), MIN_VISIBLE_CANDLES);
    assert.equal(clampVisibleCount(60, 0), 0);
    assert.equal(clampVisibleCount(60, -5), 0);
    assert.equal(clampRightOffset(Number.NaN, 60, 600), 0);
    assert.equal(clampRightOffset(-50, 60, 600), 0);
    assert.deepEqual(getVisibleIndexRange(0, { visibleCount: 60, rightOffset: 0 }), {
      startIndex: 0,
      endIndex: 0,
    });
    assert.deepEqual(
      getVisibleIndexRange(Number.NaN, { visibleCount: 60, rightOffset: 0 }),
      { startIndex: 0, endIndex: 0 },
    );
    const zoomedEmpty = zoomViewportAtFocalPoint(
      { visibleCount: 60, rightOffset: 0 },
      Number.NaN,
      150,
      300,
      600,
    );
    assert.equal(zoomedEmpty.visibleCount, 60);
  });

  it('always returns a valid start/end pair', () => {
    for (const total of [0, 1, 5, 59, 60, 61, 600]) {
      for (const rightOffset of [-5, 0, 3, 1000]) {
        const range = getVisibleIndexRange(total, {
          visibleCount: 60,
          rightOffset,
        });
        assert.ok(range.startIndex >= 0);
        assert.ok(range.endIndex <= Math.max(total, 0));
        assert.ok(range.startIndex <= range.endIndex);
      }
    }
  });
});

describe('render range', () => {
  it('adds the buffer on both sides but stays inside the data', () => {
    const middle = { visibleCount: 60, rightOffset: 100 };
    assert.deepEqual(getRenderIndexRange(600, middle), {
      startIndex: 440 - BUFFER_CANDLES,
      endIndex: 500 + BUFFER_CANDLES,
    });
    assert.deepEqual(getRenderIndexRange(600, createDefaultViewport(600)), {
      startIndex: 540 - BUFFER_CANDLES,
      endIndex: 600,
    });
    assert.deepEqual(getRenderIndexRange(60, createDefaultViewport(60)), {
      startIndex: 0,
      endIndex: 60,
    });
  });

  it('keeps the rendered node count near the visible count', () => {
    const zoomedOut = { visibleCount: MAX_VISIBLE_CANDLES, rightOffset: 0 };
    const range = getRenderIndexRange(1000, zoomedOut);
    assert.equal(
      range.endIndex - range.startIndex,
      MAX_VISIBLE_CANDLES + BUFFER_CANDLES,
    );
  });
});

describe('data changes', () => {
  it('initializes on the first load', () => {
    assert.deepEqual(
      adjustViewportForDataChange({ visibleCount: 0, rightOffset: 0 }, 0, 600),
      { visibleCount: 60, rightOffset: 0 },
    );
  });

  it('stays pinned to the newest candle when viewing the latest', () => {
    const latest = createDefaultViewport(600);
    const grown = adjustViewportForDataChange(latest, 600, 601);

    assert.equal(grown.rightOffset, 0);
    assert.equal(getVisibleIndexRange(601, grown).endIndex, 601);
  });

  it('keeps the SAME candles on screen while viewing history', () => {
    const history = { visibleCount: 60, rightOffset: 100 };
    const before = getVisibleIndexRange(600, history);

    const grown = adjustViewportForDataChange(history, 600, 601);
    const after = getVisibleIndexRange(601, grown);

    assert.equal(grown.rightOffset, 101);
    assert.deepEqual(after, before);
  });

  it('keeps the candle width steady across the 59 → 60 → 61 append', () => {
    // The width comes from visibleCount, so it must not move when the data
    // crosses the default slot count.
    const at59 = createDefaultViewport(59);
    const at60 = adjustViewportForDataChange(at59, 59, 60);
    const at61 = adjustViewportForDataChange(at60, 60, 61);

    assert.equal(at59.visibleCount, DEFAULT_VISIBLE_CANDLES);
    assert.equal(at60.visibleCount, DEFAULT_VISIBLE_CANDLES);
    assert.equal(at61.visibleCount, DEFAULT_VISIBLE_CANDLES);

    // 59 candles: all of them, right-aligned. 61: the newest 60 only.
    assert.deepEqual(getVisibleIndexRange(59, at59), {
      startIndex: 0,
      endIndex: 59,
    });
    assert.deepEqual(getVisibleIndexRange(60, at60), {
      startIndex: 0,
      endIndex: 60,
    });
    assert.deepEqual(getVisibleIndexRange(61, at61), {
      startIndex: 1,
      endIndex: 61,
    });
  });

  it('holds the history window when a live candle is appended to a short set', () => {
    // 80 candles, looking back 10: appending must not drag the view forward.
    const history = { visibleCount: 60, rightOffset: 10 };
    const before = getVisibleIndexRange(80, history);
    const grown = adjustViewportForDataChange(history, 80, 81);

    assert.equal(grown.visibleCount, 60);
    assert.equal(grown.rightOffset, 11);
    assert.deepEqual(getVisibleIndexRange(81, grown), before);
  });

  it('clamps a history viewport when the data set shrinks', () => {
    const history = { visibleCount: 60, rightOffset: 500 };
    const shrunk = adjustViewportForDataChange(history, 600, 100);

    assert.equal(shrunk.rightOffset, 40);
    assert.equal(getVisibleIndexRange(100, shrunk).startIndex, 0);
  });
});
