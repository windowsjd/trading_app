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
  isViewingLatest,
  panViewportByPixels,
  resetViewport,
  zoomViewportAtFocalPoint,
  zoomViewportByStep,
} from './candlestickViewport.ts';

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

  it('shows all 40 candles when fewer than the default exist', () => {
    const viewport = createDefaultViewport(40);
    assert.equal(viewport.visibleCount, 40);
    assert.deepEqual(getVisibleIndexRange(40, viewport), {
      startIndex: 0,
      endIndex: 40,
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
    assert.deepEqual(resetViewport(12), { visibleCount: 12, rightOffset: 0 });
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
    const viewport = createDefaultViewport(40);
    assert.equal(panViewportByPixels(viewport, 500, SLOT, 40).rightOffset, 0);
    assert.equal(panViewportByPixels(viewport, -500, SLOT, 40).rightOffset, 0);
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

  it('cannot zoom out beyond the loaded data', () => {
    const viewport = createDefaultViewport(40);
    const zoomedOut = zoomViewportAtFocalPoint(viewport, 0.1, 150, 300, 40);

    assert.equal(zoomedOut.visibleCount, 40);
    assert.equal(zoomedOut.rightOffset, 0);
  });

  it('zoom buttons step in and out around the newest candles', () => {
    const start = createDefaultViewport(600);
    const zoomedIn = zoomViewportByStep(start, 'in', 600);
    const zoomedOut = zoomViewportByStep(start, 'out', 600);

    assert.equal(zoomedIn.visibleCount, 40);
    assert.equal(zoomedOut.visibleCount, 90);
    assert.equal(zoomedIn.rightOffset, 0);
  });
});

describe('clamps and invalid input', () => {
  it('clampVisibleCount respects data-aware bounds', () => {
    assert.equal(clampVisibleCount(5, 600), MIN_VISIBLE_CANDLES);
    assert.equal(clampVisibleCount(1000, 600), MAX_VISIBLE_CANDLES);
    assert.equal(clampVisibleCount(1000, 40), 40);
    assert.equal(clampVisibleCount(30, 10), 10);
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

  it('clamps a history viewport when the data set shrinks', () => {
    const history = { visibleCount: 60, rightOffset: 500 };
    const shrunk = adjustViewportForDataChange(history, 600, 100);

    assert.equal(shrunk.rightOffset, 40);
    assert.equal(getVisibleIndexRange(100, shrunk).startIndex, 0);
  });
});
