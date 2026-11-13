import { semantic } from '../../theme/tokens';
import { priceRange, capturePriceScale, panPriceScale, scalePriceByPixels, scaledPriceRange, zoomPriceScale, type ManualPriceScale } from './candlestickPriceScale';
import { reduceCrosshair, shouldEngageVerticalPan, type CrosshairInput, type CrosshairState } from './candlestickGesturePolicy';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from '../../theme/native';
import ActionPressable from '../common/ActionPressable';

import {
  getCandlestickChartHeight,
  toChartLayoutPlatform,
} from './candlestickChartHeight';
import { formatChartPrice } from './candlestickPriceFormat';
import CandlestickChartRenderer, {
  type CandlestickChartGeometry,
  type RenderedCandle,
} from './CandlestickChartRenderer';
import { describeChartPriceLines, type ChartPriceLine } from './chartPriceLines';
// Platform-resolved: `.native.tsx` on iOS/Android, `.web.tsx` on web (the
// base file is the type contract + no-gesture fallback).
import CandlestickGestures from './CandlestickGestures';
import {
  chartLabelWidth,
  computeLeadingEmptySlots,
  computeSlotLayout,
  originalCandleIndexForX,
} from './candlestickLayout';
import {
  adjustViewportForDataChange,
  createDefaultViewport,
  getRenderIndexRange,
  getViewportFirstSlot,
  getVisibleIndexRange,
  isDefaultViewport,
  isViewingLatest,
  panViewportByPixels,
  resetViewport,
  zoomViewportAtFocalPoint,
  type CandleViewport,
} from './candlestickViewport';
import ChartEmptyState from './ChartEmptyState';
import { formatKstDateTime } from '../../utils/format';

export type CandlestickChartCandle = {
  time: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume?: string | number | null;
};

export type CandlestickChartProps = {
  candles: CandlestickChartCandle[];
  /** Price currency ('KRW' | 'USD' | …). Drives label precision/unit. */
  currencyCode?: string | null;
  /**
   * Provider-declared unit-price decimals for this asset (the same value the
   * detail header prices with). Without it a 0.24560 coin would round to $0.25
   * instead of $0.2456 on the axis, current-price label and crosshair.
   */
  displayPriceDecimals?: number | null;
  /**
   * Display conversion of every written price (axis, current price label,
   * crosshair, accessibility): the won view of a dollar asset passes its
   * USD/KRW rate with `currencyCode` 'KRW'. Candles, `currentPrice` and every
   * range stay in the candles' own currency, so a change keeps the user's
   * pan, zoom and price scale exactly as they are.
   */
  displayRate?: number | null;
  /** Live price for the current-price line. Falls back to the last candle close. */
  currentPrice?: string | number | null;
  /**
   * Fixed chart height in px. Omit it (the detail screen does) to get the
   * responsive height from `getCandlestickChartHeight`.
   */
  height?: number;
  emptyMessage?: string;
  /**
   * Changing this key resets the viewport to the latest default window. Pass
   * the timeframe (and asset) identity so switching tabs starts fresh even
   * when React Query serves the new candles from cache.
   */
  viewportResetKey?: string | number;
  /**
   * The account's own prices for this chart (holding average, open limit
   * orders, watched triggers), in the candles' currency. Drawn at their real
   * price; they never change the price range, pan or zoom.
   */
  priceLines?: ChartPriceLine[];
};

type ParsedCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bullish: boolean;
};

/** What a crosshair points at: a candle (by its time) and a price — never pixels. */
type CrosshairAnchor = { time: number; price: number };

/** The candle of this time in the time-sorted list, or -1. */
function indexOfTime(candles: ParsedCandle[], time: number): number {
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = candles[middle].time;
    if (value === time) return middle;
    if (value < time) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

const DEFAULT_WIDTH = 320;
// Parse cap aligned with the largest single API page (Binance klines: 1000).
// Only the visible window + buffer is ever rendered out of these.
const MAX_PARSED_CANDLES = 1000;
const PADDING = { top: 12, right: 66, bottom: 26, left: 8 };

/** Shared fixed-KST `YYYY-MM-DD HH:mm` display policy for chart labels. */
function formatSeoulDateTimeLabel(timeMs: number): string {
  return formatKstDateTime(new Date(timeMs));
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCandles(candles: CandlestickChartCandle[]): ParsedCandle[] {
  const parsed: ParsedCandle[] = [];
  for (const candle of candles) {
    const open = toNumber(candle.open);
    const high = toNumber(candle.high);
    const low = toNumber(candle.low);
    const close = toNumber(candle.close);
    const time = Date.parse(candle.time);
    if (
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
      !Number.isFinite(time)
    ) {
      continue;
    }
    // Guard against providers whose high/low don't fully bound open/close.
    parsed.push({
      time,
      open,
      high: Math.max(high, open, close, low),
      low: Math.min(low, open, close, high),
      close,
      bullish: close >= open,
    });
  }
  parsed.sort((a, b) => a.time - b.time);
  return parsed.length > MAX_PARSED_CANDLES
    ? parsed.slice(-MAX_PARSED_CANDLES)
    : parsed;
}

/** Lowest low and highest high (and the live price), unpadded; null without candles. */
function priceExtent(candles: ParsedCandle[], currentPriceValue: number | null) {
  if (candles.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  if (currentPriceValue !== null && Number.isFinite(currentPriceValue)) {
    min = Math.min(min, currentPriceValue);
    max = Math.max(max, currentPriceValue);
  }
  return { min, max };
}

function getPriceRange(candles: ParsedCandle[], currentPriceValue: number | null) {
  const extent = priceExtent(candles, currentPriceValue);
  return extent ? priceRange(extent.min, extent.max) : { minY: 0, maxY: 1, range: 1 };
}

/**
 * Candlestick chart with a pan/zoom viewport over the ALREADY LOADED candles.
 *
 * The viewport counts SCREEN SLOTS (60 by default on every timeframe), not
 * candles: a timeframe that only returned 12 candles draws them at the normal
 * width against the right edge with 48 empty slots on the left, instead of 12
 * absurdly fat ones.
 *
 * This component owns viewport state and geometry; `CandlestickChartRenderer`
 * draws (one renderer for every platform) and `CandlestickGestures.native/web`
 * only translate raw gestures into pan/zoom/crosshair intent. Moving beyond the
 * loaded range is intentionally impossible — fetching more history is a future
 * addition that would only extend the candle array handed in here.
 *
 * 2026-11-13: a drag on the plot moves the chart both ways, pixel for pixel —
 * sideways through the loaded candles, up and down through prices (the
 * automatic price fit gives way to a fixed window once a drag clearly moves
 * vertically, or after a price-axis change). A tap pins the crosshair (date
 * and price labels) until the next tap; it stays on its candle and price
 * while the chart moves or zooms. Display only: no price used for orders or
 * profit is ever derived from this view.
 *
 * Zoom has NO on-screen controls: mobile pinches, web wheels. `visibleCount`
 * is an internal viewport value, never a candle count the user picks. The only
 * button is the small "최신" reset, and it only appears when the viewport has
 * actually moved off the default window.
 */
export default function CandlestickChart({
  candles,
  currencyCode,
  displayPriceDecimals,
  displayRate: displayRateProp,
  currentPrice,
  height: heightOverride,
  emptyMessage = '표시할 차트 데이터가 없습니다.',
  viewportResetKey,
  priceLines,
}: CandlestickChartProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const displayRate = displayRateProp != null && Number.isFinite(displayRateProp) && displayRateProp > 0 ? displayRateProp : undefined;
  // Re-runs on rotation and on browser resize, so the chart height follows.
  // The platform matters: a landscape PHONE is wide but is not a tablet.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const chartHeight =
    heightOverride ??
    getCandlestickChartHeight({
      windowWidth,
      windowHeight,
      platform: toChartLayoutPlatform(Platform.OS),
    });
  const [crosshair, setCrosshair] = useState<CrosshairState<CrosshairAnchor>>(null);
  // Whether the stored crosshair is drawn now (read by a tap's toggle).
  const crosshairShownRef = useRef(false);
  // Where the 최신 button ends, so price labels start below it.
  const [resetBottom, setResetBottom] = useState(0);

  const [manualPriceScale, setManualPriceScale] = useState<ManualPriceScale | null>(null);
  const manualPriceScaleRef = useRef(manualPriceScale);
  manualPriceScaleRef.current = manualPriceScale;
  const gestureStartPriceRef = useRef<ManualPriceScale | null>(null);
  // The price window when the gesture began: null while prices fit automatically.
  const gestureStartManualRef = useRef<ManualPriceScale | null>(null);
  // From automatic fit, the window a drag took over and the drag's y at that moment.
  const verticalTakeoverRef = useRef<{ base: ManualPriceScale; fromY: number } | null>(null);
  const geometryRef = useRef<CandlestickChartGeometry | null>(null);

  const parsed = useMemo(() => parseCandles(candles), [candles]);
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;
  const total = parsed.length;
  const [viewport, setViewport] = useState<CandleViewport>(() =>
    createDefaultViewport(total),
  );

  // Width is based on all loaded prices so panning cannot resize the plot
  // underneath the finger. Y-axis values still use only the visible candles.
  const labelPriceRange = useMemo(
    () => getPriceRange(parsed, toNumber(currentPrice ?? null)),
    [parsed, currentPrice],
  );
  // A price drag always keeps some of the loaded prices (not just padding) in view.
  const loadedExtent = useMemo(() => priceExtent(parsed, toNumber(currentPrice ?? null)), [parsed, currentPrice]);
  const priceBoundsRef = useRef(loadedExtent);
  priceBoundsRef.current = loadedExtent;

  const chartWidth = Math.max(width, 160);
  // Reserve the longest integer part in this range plus the declared decimal
  // precision, including digits that the formatter trims on round endpoints.
  const priceLabelSample = formatChartPrice(
    `${labelPriceRange.minY < 0 ? '-' : ''}${Math.ceil(Math.max(Math.abs(labelPriceRange.minY), Math.abs(labelPriceRange.maxY)))}.12345678`,
    currencyCode,
    displayPriceDecimals,
    displayRate,
  );
  const paddingRight = Math.min(
    Math.max(PADDING.right, Math.ceil(chartLabelWidth(priceLabelSample)) + 8),
    chartWidth * 0.45,
  );
  const innerWidth = Math.max(chartWidth - PADDING.left - paddingRight, 1);
  const innerHeight = Math.max(chartHeight - PADDING.top - PADDING.bottom, 1);
  const { slotWidth, bodyWidth } = computeSlotLayout(
    innerWidth,
    viewport.visibleCount,
  );

  // Gesture handlers read the live values through refs so the adapters can be
  // memoized and never rebuild mid-gesture.
  const totalRef = useRef(total);
  totalRef.current = total;
  const innerWidthRef = useRef(innerWidth);
  innerWidthRef.current = innerWidth;
  const innerHeightRef = useRef(innerHeight);
  innerHeightRef.current = innerHeight;
  const slotWidthRef = useRef(slotWidth);
  slotWidthRef.current = slotWidth;
  const gestureStartViewportRef = useRef<CandleViewport>(viewport);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Timeframe/asset switch resets to the latest default window; otherwise a
  // data-length change follows the right edge (live append) or preserves the
  // history position the user is looking at.
  const lastResetKeyRef = useRef(viewportResetKey);
  const previousTotalRef = useRef(total);
  useEffect(() => {
    const keyChanged = lastResetKeyRef.current !== viewportResetKey;
    lastResetKeyRef.current = viewportResetKey;
    const previousTotal = previousTotalRef.current;
    previousTotalRef.current = total;
    if (keyChanged) {
      setManualPriceScale(null);
      gestureStartPriceRef.current = null;
      setCrosshair(null);
      setViewport(resetViewport(total));
      return;
    }
    setViewport((current) =>
      adjustViewportForDataChange(current, previousTotal, total),
    );
  }, [total, viewportResetKey]);

  const onLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.floor(event.nativeEvent.layout.width);
    if (nextWidth > 0 && nextWidth !== width) setWidth(nextWidth);
  };

  const handleGestureStart = useCallback(() => {
    gestureStartViewportRef.current = viewportRef.current;
    gestureStartManualRef.current = manualPriceScaleRef.current;
    verticalTakeoverRef.current = null;
    gestureStartPriceRef.current = manualPriceScaleRef.current ??
      (geometryRef.current ? capturePriceScale(geometryRef.current) : null);
  }, []);

  const handlePan = useCallback((translationX: number, translationY: number) => {
    setViewport((current) => {
      const next = panViewportByPixels(
        gestureStartViewportRef.current,
        translationX,
        slotWidthRef.current,
        totalRef.current,
      );
      return next.rightOffset === current.rightOffset &&
        next.visibleCount === current.visibleCount
        ? current
        : next;
    });
    // Prices: a fixed window moves with the finger at once; the automatic fit
    // gives way only to a clearly vertical drag, taking over the window as it
    // is drawn at that moment (no jump), with the drag counted from there.
    let base = gestureStartManualRef.current;
    let fromY = 0;
    if (!base) {
      const takeover = verticalTakeoverRef.current ?? (
        shouldEngageVerticalPan(translationX, translationY) && geometryRef.current
          ? { base: capturePriceScale(geometryRef.current), fromY: translationY }
          : null);
      if (!takeover) return;
      verticalTakeoverRef.current = takeover;
      ({ base, fromY } = takeover);
    }
    setManualPriceScale(panPriceScale(base, translationY - fromY, innerHeightRef.current, priceBoundsRef.current));
  }, []);

  const handleZoom = useCallback((scale: number, focalX: number) => {
    setViewport((current) => {
      const next = zoomViewportAtFocalPoint(
        gestureStartViewportRef.current,
        scale,
        focalX,
        innerWidthRef.current,
        totalRef.current,
      );
      return next.visibleCount === current.visibleCount &&
        next.rightOffset === current.rightOffset
        ? current
        : next;
    });
  }, []);

  const handlePriceScale = useCallback((deltaY: number) => {
    const start = gestureStartPriceRef.current;
    if (start) setManualPriceScale(scalePriceByPixels(start, deltaY));
  }, []);

  const handlePriceZoom = useCallback((scale: number, focalY: number) => {
    const start = gestureStartPriceRef.current;
    if (start)
      setManualPriceScale(
        zoomPriceScale(start, scale, (focalY - PADDING.top) / innerHeightRef.current),
      );
  }, []);

  // A point on the chart → the candle and the price under it, as drawn now.
  const anchorOf = useCallback((point: { x: number; y: number }): CrosshairAnchor | null => {
    const g = geometryRef.current;
    const list = parsedRef.current;
    if (!g || !list.length) return null;
    const x = Math.max(PADDING.left, Math.min(point.x, PADDING.left + g.innerWidth));
    const y = Math.max(PADDING.top, Math.min(point.y, PADDING.top + g.innerHeight));
    const { startIndex, endIndex } = getVisibleIndexRange(list.length, viewportRef.current);
    const index = originalCandleIndexForX({
      x,
      paddingLeft: PADDING.left,
      slotWidth: g.slotWidth,
      viewportVisibleCount: viewportRef.current.visibleCount,
      startIndex,
      endIndex,
      leadingEmptySlots: g.leadingEmptySlots,
      slotShift: g.slotShift,
    });
    const candle = list[index];
    if (!candle) return null;
    return { time: candle.time, price: g.minY + (1 - (y - PADDING.top) / g.innerHeight) * g.range };
  }, []);

  const handleCrosshair = useCallback((input: CrosshairInput) => {
    setCrosshair((current) => reduceCrosshair(current, input, anchorOf, crosshairShownRef.current));
  }, [anchorOf]);

  const handleGestureEnd = useCallback(() => {
    gestureStartViewportRef.current = viewportRef.current;
  }, []);

  const resetToLatest = useCallback(() => {
    setManualPriceScale(null);
    gestureStartPriceRef.current = null;
    setCrosshair(null);
    setViewport(resetViewport(totalRef.current));
  }, []);

  const geometry = useMemo<CandlestickChartGeometry | null>(() => {
    if (total === 0) return null;
    const { startIndex, endIndex } = getVisibleIndexRange(total, viewport);
    if (endIndex <= startIndex) return null;

    // Short data sets keep the default candle width and sit against the right
    // edge; the shortfall becomes empty slots on the left. Between whole
    // candles the window is shifted by part of a slot (slotShift).
    const firstSlot = getViewportFirstSlot(total, viewport);
    const leadingEmptySlots = firstSlot > 0
      ? computeLeadingEmptySlots(viewport.visibleCount, endIndex - startIndex)
      : 0;
    return {
      width: chartWidth,
      height: chartHeight,
      innerWidth,
      innerHeight,
      padding: { ...PADDING, right: paddingRight },
      slotWidth,
      bodyWidth,
      startIndex,
      leadingEmptySlots,
      slotShift: firstSlot - leadingEmptySlots,
      ...(manualPriceScale ? scaledPriceRange(manualPriceScale) : getPriceRange(
        parsed.slice(startIndex, endIndex),
        isViewingLatest(viewport)
          ? (toNumber(currentPrice ?? null) ?? parsed[total - 1].close)
          : null,
      )),
    };
  }, [
    manualPriceScale,
    parsed,
    total,
    viewport,
    currentPrice,
    paddingRight,
    chartWidth,
    chartHeight,
    innerWidth,
    innerHeight,
    slotWidth,
    bodyWidth,
  ]);

  geometryRef.current = geometry;

  // Visible window + buffer only: at most ~180 + 4 SVG candle groups even when
  // 1000 candles are loaded.
  const renderedCandles = useMemo<RenderedCandle[]>(() => {
    if (total === 0) return [];
    const { startIndex, endIndex } = getRenderIndexRange(total, viewport);
    const list: RenderedCandle[] = [];
    for (let index = startIndex; index < endIndex; index += 1) {
      list.push({ index, ...parsed[index] });
    }
    return list;
  }, [parsed, total, viewport]);

  if (total < 1 || !geometry) {
    return <ChartEmptyState message={emptyMessage} />;
  }

  const { startIndex, endIndex } = getVisibleIndexRange(total, viewport);
  const viewingLatest = isViewingLatest(viewport);
  const livePrice = toNumber(currentPrice ?? null);
  const currentPriceValue = viewingLatest
    ? (livePrice ?? parsed[total - 1].close)
    : null;

  // The crosshair is stored as a candle (time) and a price, so after a pan or
  // zoom it still names the same date and price; drawn only while that candle
  // and price are on the plot (a pinned one panned away comes back with them).
  const crosshairIndex = crosshair ? indexOfTime(parsed, crosshair.anchor.time) : -1;
  const crosshairX = crosshairIndex >= 0
    ? PADDING.left + (geometry.leadingEmptySlots + geometry.slotShift + crosshairIndex - startIndex + 0.5) * slotWidth
    : NaN;
  const crosshairY = crosshair
    ? PADDING.top + (1 - (crosshair.anchor.price - geometry.minY) / geometry.range) * innerHeight
    : NaN;
  const crosshairState = crosshair && crosshairIndex >= startIndex && crosshairIndex < endIndex &&
    crosshairX >= PADDING.left - 0.5 && crosshairX <= PADDING.left + innerWidth + 0.5 &&
    crosshairY >= PADDING.top - 0.5 && crosshairY <= PADDING.top + innerHeight + 0.5
    ? { index: crosshairIndex, y: crosshairY }
    : null;
  crosshairShownRef.current = !!crosshairState;

  // The viewport is off its default window, so the reset affordance would do
  // something. (It is the only chart button: zoom has no controls.)
  const canResetViewport = !!manualPriceScale || !isDefaultViewport(viewport, total);

  const accessibilityLabel = [
    '캔들 차트',
    viewingLatest ? '최신 구간' : '과거 구간',
    `현재가 ${formatChartPrice(
      livePrice ?? parsed[total - 1].close,
      currencyCode,
      displayPriceDecimals,
      displayRate,
    )}`,
    ...(priceLines?.length
      ? [describeChartPriceLines(priceLines, (price) =>
          formatChartPrice(price, currencyCode, displayPriceDecimals, displayRate))]
      : []),
  ].join(', ');

  return (
    <View style={styles.wrapper}>
      <View
        onLayout={onLayout}
        style={[styles.container, { height: chartHeight }]}
        accessible
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
      >
        <CandlestickGestures
          key={viewportResetKey}
          innerWidth={innerWidth}
          paddingLeft={PADDING.left}
          slotWidth={slotWidth}
          chartWidth={chartWidth}
          chartHeight={chartHeight}
          onGestureStart={handleGestureStart}
          onPan={handlePan}
          onZoom={handleZoom}
          onPriceScale={handlePriceScale}
          onPriceZoom={handlePriceZoom}
          onCrosshair={handleCrosshair}
          onGestureEnd={handleGestureEnd}
        >
          <CandlestickChartRenderer
            geometry={geometry}
            candles={renderedCandles}
            currencyCode={currencyCode}
            displayPriceDecimals={displayPriceDecimals}
            displayRate={displayRate}
            currentPrice={currentPriceValue}
            currentBullish={parsed[total - 1].bullish}
            crosshair={crosshairState}
            formatTimeLabel={formatSeoulDateTimeLabel}
            firstVisibleTime={parsed[startIndex]?.time ?? null}
            lastVisibleTime={parsed[endIndex - 1]?.time ?? null}
            priceLines={priceLines}
            // Before the button is measured, its default 28 dp plus its 8 dp inset.
            labelTop={canResetViewport ? (resetBottom || 36) + 4 : 0}
          />
        </CandlestickGestures>
      </View>

      {/* Only affordance on the chart: back to the latest window at the
          default density. Hidden while already there, and a SIBLING of the
          `accessible` chart box so screen readers can still reach it. */}
      {canResetViewport ? (
        <ActionPressable
          style={styles.resetButton}
          onLayout={(event: LayoutChangeEvent) => {
            const { y, height } = event.nativeEvent.layout;
            setResetBottom(Math.ceil(y + height));
          }}
          onPress={resetToLatest}
          accessibilityRole="button"
          accessibilityLabel="차트를 최신 구간으로 초기화"
        >
          <Text style={styles.resetText}>최신</Text>
        </ActionPressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // `relative` anchors the absolutely positioned reset button to the chart box.
  wrapper: { width: '100%', position: 'relative' },
  container: {
    width: '100%',
    backgroundColor: semantic.surface,
    borderRadius: 8,
    overflow: 'hidden',
  },
  resetButton: {
    position: 'absolute',
    top: 8,
    left: 8,
    minHeight: 28,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.raised,
  },
  resetText: { fontSize: 12, fontWeight: '600', color: semantic.text },
});
