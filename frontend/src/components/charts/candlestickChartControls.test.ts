// Source-level guards for the chart's UI contract.
//
// The frontend test runner is `node --test` over plain `.ts` files — there is
// no React renderer here — so "this control must not exist" is asserted
// against the component source. It is coarse, but it is what actually catches
// a zoom button or a visible candle-count creeping back in.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const chartsDir = dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) =>
  readFileSync(join(chartsDir, relativePath), 'utf8');

const chartSource = read('CandlestickChart.tsx');
const rendererSource = read('CandlestickChartRenderer.tsx');
const nativeGestureSource = read('CandlestickGestures.native.tsx');
const webGestureSource = read('CandlestickGestures.web.tsx');
const detailScreenSource = read('../../screens/asset/AssetDetailScreen.tsx');

describe('chart controls: zoom UI is gone', () => {
  it('renders no zoom-in control', () => {
    assert.ok(!chartSource.includes('＋'), 'zoom-in glyph removed');
    assert.ok(!chartSource.includes('차트 확대'), 'zoom-in a11y label removed');
    assert.ok(!/\bzoomIn\b/.test(chartSource), 'zoom-in callback removed');
  });

  it('renders no zoom-out control', () => {
    assert.ok(!chartSource.includes('−'), 'zoom-out glyph removed');
    assert.ok(!chartSource.includes('차트 축소'), 'zoom-out a11y label removed');
    assert.ok(!/\bzoomOut\b/.test(chartSource), 'zoom-out callback removed');
  });

  it('has no button-only zoom plumbing or styles left', () => {
    assert.ok(!chartSource.includes('zoomViewportByStep'));
    assert.ok(!chartSource.includes('styles.controls'));
    assert.ok(!chartSource.includes('controlButton'));
    assert.ok(!chartSource.includes('controlHint'));
  });

  it('shows no visible candle-count text anywhere on the chart', () => {
    // e.g. `{endIndex - startIndex}개` / `{viewport.visibleCount}개`
    assert.ok(
      !/\{[^}]*\}\s*개/.test(chartSource),
      'no rendered "N개" candle-count text',
    );
    assert.ok(
      !/visibleCount[^\n]*개/.test(chartSource),
      'visibleCount is never surfaced as user-facing text',
    );
    assert.ok(
      !/개\s*표시/.test(chartSource),
      'no candle-count phrase in the accessibility label either',
    );
  });

  it('offers no candle-count picker on the detail screen', () => {
    assert.ok(!detailScreenSource.includes('visibleCount'));
    assert.ok(!/\d+개/.test(detailScreenSource));
  });

  it('keeps ONE small "최신" reset button, hidden at the default viewport', () => {
    assert.ok(chartSource.includes('>최신<'), 'reset button label');
    assert.ok(
      chartSource.includes('차트를 최신 구간으로 초기화'),
      'reset a11y label',
    );
    assert.ok(
      chartSource.includes('canResetViewport ?'),
      'reset button only renders when the viewport moved off the default',
    );
    assert.ok(
      chartSource.includes('isDefaultViewport(viewport, total)'),
      'the reset affordance is driven by the viewport itself',
    );
    assert.ok(
      chartSource.includes('setViewport(resetViewport(totalRef.current))'),
      'reset returns to 60 slots at rightOffset 0',
    );
    assert.ok(
      /resetToLatest = useCallback\(\(\) => \{\s*setCrosshair\(null\);/.test(
        chartSource,
      ),
      'reset also clears the crosshair',
    );
    const pressableCount = (chartSource.match(/<Pressable/g) ?? []).length;
    assert.equal(pressableCount, 1, 'the reset button is the only chart button');
  });

  it('keeps the internal visibleCount viewport state', () => {
    assert.ok(chartSource.includes('viewport.visibleCount'));
    assert.ok(chartSource.includes('zoomViewportAtFocalPoint'));
    assert.ok(chartSource.includes('panViewportByPixels'));
  });
});

describe('chart height', () => {
  it('uses the responsive height policy instead of a fixed 240px', () => {
    assert.ok(chartSource.includes('getCandlestickChartHeight'));
    assert.ok(chartSource.includes('useWindowDimensions'));
    assert.ok(!/height = 240/.test(chartSource), 'the 240px default is gone');
  });

  it('lets an explicit height prop win over the responsive default', () => {
    assert.ok(
      chartSource.includes(
        'heightOverride ?? getCandlestickChartHeight(windowWidth, windowHeight)',
      ),
    );
  });

  it('does not pin a fixed chart height from the detail screen', () => {
    const chartUsage = detailScreenSource.slice(
      detailScreenSource.indexOf('<CandlestickChart'),
      detailScreenSource.indexOf('<CandlestickChart') + 500,
    );
    assert.ok(chartUsage.length > 0, 'detail screen renders the chart');
    assert.ok(!chartUsage.includes('height='), 'no fixed height prop passed');
  });
});

describe('existing behaviour that must not regress', () => {
  it('keeps the detail screen on ONE vertical ScrollView', () => {
    assert.equal(
      (detailScreenSource.match(/<ScrollView/g) ?? []).length,
      1,
      'no nested scroll views were added for the taller chart',
    );
    assert.ok(!detailScreenSource.includes('horizontal'), 'no horizontal scroll view');
  });

  it('keeps the timeframe tabs and their viewport reset key', () => {
    assert.ok(detailScreenSource.includes('ASSET_CHART_TIMEFRAMES.map'));
    assert.ok(
      detailScreenSource.includes(
        'viewportResetKey={`${assetId}:${selectedTimeframe.interval}`}',
      ),
      'switching timeframe resets the viewport to the latest default window',
    );
    assert.ok(detailScreenSource.includes('flexWrap'));
  });

  it('keeps the SVG clip path and price precision plumbing', () => {
    assert.ok(rendererSource.includes('ClipPath'));
    assert.ok(rendererSource.includes('clipPath='));
    assert.ok(chartSource.includes('displayPriceDecimals'));
    assert.ok(rendererSource.includes('displayPriceDecimals'));
    assert.ok(detailScreenSource.includes('displayPriceDecimals={displayPriceDecimals}'));
  });
});

describe('gesture adapters', () => {
  it('native: a long press that leaves the chart ends the crosshair', () => {
    assert.ok(
      nativeGestureSource.includes('.shouldCancelWhenOutside(true)'),
      'recognizers cancel when the finger leaves the chart',
    );
    assert.ok(
      !nativeGestureSource.includes('.shouldCancelWhenOutside(false)'),
      'the old keep-alive-outside setting is gone',
    );
    assert.ok(
      nativeGestureSource.includes('isWithinChartBounds(point, chartBox)'),
      'the scrub itself also checks the chart box',
    );
  });

  it('native: every start/end goes through the lifecycle session', () => {
    assert.ok(nativeGestureSource.includes('createChartGestureSession'));
    assert.ok(nativeGestureSource.includes("session.takeOver('pinch')"));
    assert.ok(nativeGestureSource.includes("session.end('pan')"));
    assert.ok(nativeGestureSource.includes("session.end('pinch')"));
    assert.ok(nativeGestureSource.includes("session.end('crosshair')"));
    // The adapter must not call the chart's lifecycle callbacks directly any
    // more — that is what used to double-fire onGestureEnd.
    assert.ok(!/[^.]\bonGestureEnd\(\)/.test(nativeGestureSource));
    assert.ok(!/[^.]\bonGestureStart\(\)/.test(nativeGestureSource));
  });

  it('native: one-finger vertical swipes still belong to the parent ScrollView', () => {
    assert.ok(nativeGestureSource.includes('.activeOffsetX('));
    assert.ok(nativeGestureSource.includes('.failOffsetY('));
    assert.ok(nativeGestureSource.includes('.maxPointers(1)'));
    assert.ok(nativeGestureSource.includes('Gesture.Pinch()'), 'pinch zoom kept');
  });

  it('web: wheel over the chart is consumed as zoom/pan, drag still pans', () => {
    assert.ok(webGestureSource.includes("addEventListener('wheel', onWheel, { passive: false })"));
    assert.ok(webGestureSource.includes('event.preventDefault()'));
    assert.ok(webGestureSource.includes('createWheelGestureSession'));
    assert.ok(webGestureSource.includes('wheelSession.dispose()'), 'idle timer cleaned up');
    assert.ok(webGestureSource.includes("classifyWheelIntent(event) === 'zoom'"));
    assert.ok(webGestureSource.includes("addEventListener('mousedown'"), 'mouse drag pan kept');
    assert.ok(webGestureSource.includes("addEventListener('mousemove'"), 'hover crosshair kept');
  });
});
