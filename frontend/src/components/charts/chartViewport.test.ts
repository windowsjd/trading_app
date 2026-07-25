import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_VISIBLE_CANDLES,
  MAX_VISIBLE_CANDLES,
  MIN_VISIBLE_CANDLES,
  adjustViewportForDataChange,
  clampViewportOffset,
  clampViewportSize,
  createInitialViewport,
  indexForPixel,
  isAtLatestEdge,
  isHorizontalPanIntent,
  panViewportByPixels,
  pinchScale,
  strictVisibleIndexRange,
  touchDistance,
  viewportSlotLayout,
  visibleIndexRange,
  wheelZoomScale,
  xCenterForIndex,
  zoomViewportAtRatio,
  zoomViewportAtPixel,
} from './chartViewport.ts';

const INNER = 300;

describe('createInitialViewport', () => {
  it('shows the latest 60 candles for dense data', () => {
    const viewport = createInitialViewport(576);
    assert.equal(viewport.size, DEFAULT_VISIBLE_CANDLES);
    assert.equal(viewport.offset, 576 - 60);
    assert.equal(isAtLatestEdge(viewport, 576), true);
  });

  it('keeps 60-slot density with sparse data (right-aligned, blank left)', () => {
    const viewport = createInitialViewport(30);
    // Same slot width as any other timeframe: 60 slots, data on the right.
    assert.equal(viewport.size, DEFAULT_VISIBLE_CANDLES);
    assert.equal(viewport.offset, -30);
    const { start, endExclusive } = strictVisibleIndexRange(viewport, 30);
    assert.equal(start, 0);
    assert.equal(endExclusive, 30);
  });

  it('handles an empty chart without NaN', () => {
    const viewport = createInitialViewport(0);
    const range = visibleIndexRange(viewport, 0);
    assert.equal(range.start, 0);
    assert.equal(range.endExclusive, 0);
  });
});

describe('pan', () => {
  it('dragging right reveals older candles and clamps at the oldest', () => {
    const start = createInitialViewport(200); // offset 140
    const panned = panViewportByPixels(start, 50, INNER, 200);
    // 50px at 5px/slot = 10 candles towards history.
    assert.equal(Math.round(panned.offset), 130);

    const flooded = panViewportByPixels(start, 100_000, INNER, 200);
    assert.equal(flooded.offset, 0);
  });

  it('dragging left moves towards the latest candle and clamps there', () => {
    const middle = { offset: 50, size: 60 };
    const panned = panViewportByPixels(middle, -25, INNER, 200);
    assert.equal(Math.round(panned.offset), 55);

    const flooded = panViewportByPixels(middle, -100_000, INNER, 200);
    assert.equal(flooded.offset, 140);
    assert.equal(isAtLatestEdge(flooded, 200), true);
  });

  it('cannot pan at all when the data is smaller than the window', () => {
    const sparse = createInitialViewport(30);
    assert.equal(panViewportByPixels(sparse, 500, INNER, 30).offset, -30);
    assert.equal(panViewportByPixels(sparse, -500, INNER, 30).offset, -30);
  });
});

describe('zoom', () => {
  it('zooming in shrinks the window and keeps the anchor candle fixed', () => {
    const start = { offset: 100, size: 60 };
    const anchorRatio = 0.5;
    const anchorIndex = start.offset + anchorRatio * start.size; // 130
    const zoomed = zoomViewportAtRatio(start, 2, anchorRatio, 400);

    assert.equal(zoomed.size, 30);
    const anchorAfter = zoomed.offset + anchorRatio * zoomed.size;
    assert.ok(Math.abs(anchorAfter - anchorIndex) < 1e-9);
  });

  it('zooming out grows the window and clamps to the data', () => {
    const start = { offset: 100, size: 60 };
    const zoomed = zoomViewportAtRatio(start, 0.5, 0.5, 400);
    assert.equal(zoomed.size, 120);

    const maxed = zoomViewportAtRatio(start, 0.01, 0.5, 400);
    assert.equal(maxed.size, MAX_VISIBLE_CANDLES);
    assert.ok(maxed.offset >= 0);
    assert.ok(maxed.offset + maxed.size <= 400);
  });

  it('never zooms past the minimum window', () => {
    const start = { offset: 100, size: 60 };
    const zoomed = zoomViewportAtRatio(start, 1000, 0.5, 400);
    assert.equal(zoomed.size, MIN_VISIBLE_CANDLES);
  });

  it('caps zoom-out for sparse data at the 60-slot default', () => {
    const sparse = createInitialViewport(30);
    const zoomedOut = zoomViewportAtRatio(sparse, 0.1, 0.5, 30);
    assert.equal(zoomedOut.size, DEFAULT_VISIBLE_CANDLES);
    assert.equal(zoomedOut.offset, -30);
  });

  it('zoomViewportAtPixel anchors at the pointer position', () => {
    const start = { offset: 100, size: 60 };
    // Pointer at the right edge: the newest visible candle stays put.
    const zoomed = zoomViewportAtPixel(start, 2, INNER, INNER, 400);
    const rightBefore = start.offset + start.size;
    const rightAfter = zoomed.offset + zoomed.size;
    assert.ok(Math.abs(rightAfter - rightBefore) < 1e-9);
  });
});

describe('clamps', () => {
  it('clampViewportSize respects data-aware bounds', () => {
    assert.equal(clampViewportSize(5, 400), MIN_VISIBLE_CANDLES);
    assert.equal(clampViewportSize(1000, 400), MAX_VISIBLE_CANDLES);
    assert.equal(clampViewportSize(1000, 100), 100);
    assert.equal(clampViewportSize(Number.NaN, 400), DEFAULT_VISIBLE_CANDLES);
  });

  it('clampViewportOffset pins sparse data to the single legal position', () => {
    assert.equal(clampViewportOffset(10, 60, 30), -30);
    assert.equal(clampViewportOffset(-500, 60, 200), 0);
    assert.equal(clampViewportOffset(500, 60, 200), 140);
  });
});

describe('adjustViewportForDataChange', () => {
  it('initializes on the first data load', () => {
    const viewport = adjustViewportForDataChange({ offset: -60, size: 60 }, 0, 200);
    assert.deepEqual(viewport, { offset: 140, size: 60 });
  });

  it('follows the latest candle while parked at the right edge', () => {
    const atEdge = { offset: 140, size: 60 };
    const grown = adjustViewportForDataChange(atEdge, 200, 201);
    assert.equal(grown.offset, 141);
    assert.equal(isAtLatestEdge(grown, 201), true);
  });

  it('keeps a history position when the user panned back', () => {
    const inHistory = { offset: 40, size: 60 };
    const grown = adjustViewportForDataChange(inHistory, 200, 201);
    assert.equal(grown.offset, 40);
  });
});

describe('visible ranges and pixel mapping', () => {
  it('renders only the window plus the buffer', () => {
    const viewport = { offset: 100, size: 60 };
    const range = visibleIndexRange(viewport, 400);
    assert.equal(range.start, 96);
    assert.equal(range.endExclusive, 164);
    // Strict range (y-axis) has no buffer.
    assert.deepEqual(strictVisibleIndexRange(viewport, 400), {
      start: 100,
      endExclusive: 160,
    });
  });

  it('clamps ranges to the data edges', () => {
    const range = visibleIndexRange({ offset: 0, size: 60 }, 400);
    assert.equal(range.start, 0);
    const rightRange = visibleIndexRange({ offset: 340, size: 60 }, 400);
    assert.equal(rightRange.endExclusive, 400);
  });

  it('maps candle index to x and back', () => {
    const viewport = { offset: 100, size: 60 };
    const x = xCenterForIndex(130, viewport, INNER, 8);
    assert.equal(indexForPixel(x, viewport, INNER, 8, 400), 130);
  });

  it('snaps pointer positions outside the data to the nearest candle', () => {
    const sparse = createInitialViewport(30); // offset -30
    // Far left = blank region → first candle; far right → last candle.
    assert.equal(indexForPixel(0, sparse, INNER, 8, 30), 0);
    assert.equal(indexForPixel(INNER + 8, sparse, INNER, 8, 30), 29);
    assert.equal(indexForPixel(150, createInitialViewport(0), INNER, 8, 0), null);
  });

  it('keeps slot/body widths sane at extreme zoom levels', () => {
    const zoomedOut = viewportSlotLayout(300, MAX_VISIBLE_CANDLES);
    assert.ok(zoomedOut.bodyWidth > 0);
    assert.ok(zoomedOut.bodyWidth <= zoomedOut.slotWidth + 1e-9);

    const zoomedIn = viewportSlotLayout(300, MIN_VISIBLE_CANDLES);
    assert.ok(zoomedIn.bodyWidth <= 16);
  });
});

describe('gesture math', () => {
  it('wheel deltas map to bounded zoom factors', () => {
    assert.ok(wheelZoomScale(-100) > 1); // scroll up → zoom in
    assert.ok(wheelZoomScale(100) < 1);
    assert.equal(wheelZoomScale(0), 1);
    assert.ok(wheelZoomScale(-100_000) <= 2.5);
    assert.ok(wheelZoomScale(100_000) >= 0.4);
  });

  it('pinch scale is the distance ratio with safe bounds', () => {
    assert.equal(pinchScale(200, 100), 2);
    assert.equal(pinchScale(50, 100), 0.5);
    assert.equal(pinchScale(100, 0), 1);
  });

  it('touchDistance is the euclidean distance', () => {
    assert.equal(
      touchDistance({ pageX: 0, pageY: 0 }, { pageX: 3, pageY: 4 }),
      5,
    );
  });

  it('claims only clearly horizontal drags', () => {
    assert.equal(isHorizontalPanIntent(20, 2), true);
    assert.equal(isHorizontalPanIntent(-20, 2), true);
    assert.equal(isHorizontalPanIntent(4, 2), false); // under the slop
    assert.equal(isHorizontalPanIntent(20, 30), false); // vertical → ScrollView
  });
});
