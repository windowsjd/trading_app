import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { formatMoney } from '../../utils/format';
import CandlestickChartRenderer, {
  type CandlestickChartGeometry,
  type RenderedCandle,
} from './CandlestickChartRenderer';
// Platform-resolved: `.native.tsx` on iOS/Android, `.web.tsx` on web (the
// base file is the type contract + no-gesture fallback).
import CandlestickGestures from './CandlestickGestures';
import { computeSlotLayout, visibleOffsetForX } from './candlestickLayout';
import {
  adjustViewportForDataChange,
  createDefaultViewport,
  getRenderIndexRange,
  getVisibleIndexRange,
  isViewingLatest,
  panViewportByPixels,
  resetViewport,
  zoomViewportAtFocalPoint,
  zoomViewportByStep,
  type CandleViewport,
} from './candlestickViewport';
import ChartEmptyState from './ChartEmptyState';

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
  /** Live price for the current-price line. Falls back to the last candle close. */
  currentPrice?: string | number | null;
  height?: number;
  emptyMessage?: string;
  /**
   * Changing this key resets the viewport to the latest default window. Pass
   * the timeframe (and asset) identity so switching tabs starts fresh even
   * when React Query serves the new candles from cache.
   */
  viewportResetKey?: string | number;
};

type ParsedCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bullish: boolean;
};

const DEFAULT_WIDTH = 320;
// Parse cap aligned with the largest single API page (Binance klines: 1000).
// Only the visible window + buffer is ever rendered out of these.
const MAX_PARSED_CANDLES = 1000;
const PADDING = { top: 12, right: 66, bottom: 26, left: 8 };

const WEEKDAY_KO: Record<string, string> = {
  Sun: '일',
  Mon: '월',
  Tue: '화',
  Wed: '수',
  Thu: '목',
  Fri: '금',
  Sat: '토',
};

const seoulDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

/** "목, 2026-07-09, 12:30" in Asia/Seoul (Korean weekday). */
function formatSeoulDateTimeLabel(timeMs: number): string {
  if (!Number.isFinite(timeMs)) return '-';
  const parts = seoulDateTimeFormatter.formatToParts(new Date(timeMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAY_KO[get('weekday')] ?? get('weekday');
  return `${weekday}, ${get('year')}-${get('month')}-${get('day')}, ${get('hour')}:${get('minute')}`;
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

/**
 * Candlestick chart with a pan/zoom viewport over the ALREADY LOADED candles.
 *
 * This component owns viewport state and geometry; `CandlestickChartRenderer`
 * draws (one renderer for every platform) and `CandlestickGestures.native/web`
 * only translate raw gestures into pan/zoom/crosshair intent. Moving beyond the
 * loaded range is intentionally impossible — fetching more history is a future
 * addition that would only extend the candle array handed in here.
 */
export default function CandlestickChart({
  candles,
  currencyCode,
  currentPrice,
  height = 240,
  emptyMessage = '표시할 차트 데이터가 없습니다.',
  viewportResetKey,
}: CandlestickChartProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [crosshair, setCrosshair] = useState<{ x: number; y: number } | null>(
    null,
  );

  const parsed = useMemo(() => parseCandles(candles), [candles]);
  const total = parsed.length;
  const [viewport, setViewport] = useState<CandleViewport>(() =>
    createDefaultViewport(total),
  );

  const chartWidth = Math.max(width, 160);
  const innerWidth = Math.max(chartWidth - PADDING.left - PADDING.right, 1);
  const innerHeight = Math.max(height - PADDING.top - PADDING.bottom, 1);
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
  }, []);

  const handlePan = useCallback((translationX: number) => {
    setViewport((current) => {
      const next = panViewportByPixels(
        gestureStartViewportRef.current,
        translationX,
        slotWidthRef.current,
        totalRef.current,
      );
      // Only a real index change re-renders (gestures fire per pixel).
      return next.rightOffset === current.rightOffset &&
        next.visibleCount === current.visibleCount
        ? current
        : next;
    });
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

  const handleCrosshair = useCallback(
    (position: { x: number; y: number } | null) => {
      if (!position) {
        setCrosshair(null);
        return;
      }
      const clampedX = Math.max(
        PADDING.left,
        Math.min(position.x, PADDING.left + innerWidthRef.current),
      );
      const clampedY = Math.max(
        PADDING.top,
        Math.min(position.y, PADDING.top + innerHeight),
      );
      setCrosshair({ x: clampedX, y: clampedY });
    },
    [innerHeight],
  );

  const handleGestureEnd = useCallback(() => {
    gestureStartViewportRef.current = viewportRef.current;
  }, []);

  const zoomIn = useCallback(() => {
    setViewport((current) => zoomViewportByStep(current, 'in', totalRef.current));
  }, []);
  const zoomOut = useCallback(() => {
    setViewport((current) =>
      zoomViewportByStep(current, 'out', totalRef.current),
    );
  }, []);
  const resetToLatest = useCallback(() => {
    setCrosshair(null);
    setViewport(resetViewport(totalRef.current));
  }, []);

  const geometry = useMemo<CandlestickChartGeometry | null>(() => {
    if (total === 0) return null;
    const { startIndex, endIndex } = getVisibleIndexRange(total, viewport);
    if (endIndex <= startIndex) return null;

    const viewingLatest = isViewingLatest(viewport);
    const livePrice = toNumber(currentPrice ?? null);
    const currentPriceValue = viewingLatest
      ? (livePrice ?? parsed[total - 1].close)
      : null;

    // Y axis from the candles ACTUALLY on screen. In history the current price
    // is excluded entirely so it cannot distort the range.
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = startIndex; index < endIndex; index += 1) {
      const candle = parsed[index];
      if (candle.low < minY) minY = candle.low;
      if (candle.high > maxY) maxY = candle.high;
    }
    if (currentPriceValue !== null && Number.isFinite(currentPriceValue)) {
      minY = Math.min(minY, currentPriceValue);
      maxY = Math.max(maxY, currentPriceValue);
    }
    let range = maxY - minY;
    if (range <= 0) {
      const bump = Math.max(Math.abs(maxY) * 0.01, 1);
      minY -= bump;
      maxY += bump;
      range = maxY - minY;
    }
    const pad = range * 0.08;
    minY -= pad;
    maxY += pad;
    range = maxY - minY;

    return {
      width: chartWidth,
      height,
      innerWidth,
      innerHeight,
      padding: PADDING,
      slotWidth,
      bodyWidth,
      startIndex,
      minY,
      maxY,
      range,
    };
  }, [
    parsed,
    total,
    viewport,
    currentPrice,
    chartWidth,
    height,
    innerWidth,
    innerHeight,
    slotWidth,
    bodyWidth,
  ]);

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

  // Crosshair x → visible offset → ORIGINAL candle index, so its labels always
  // describe the candle actually under the line.
  const crosshairState = crosshair
    ? {
        index:
          startIndex +
          visibleOffsetForX(
            crosshair.x,
            PADDING.left,
            slotWidth,
            endIndex - startIndex,
          ),
        y: crosshair.y,
      }
    : null;

  const accessibilityLabel = [
    '캔들 차트',
    `${endIndex - startIndex}개 표시 중`,
    viewingLatest ? '최신 구간' : '과거 구간',
    `현재가 ${formatMoney(
      livePrice ?? parsed[total - 1].close,
      currencyCode,
    )}`,
  ].join(', ');

  return (
    <View style={styles.wrapper}>
      <View
        onLayout={onLayout}
        style={[styles.container, { height }]}
        accessible
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
      >
        <CandlestickGestures
          innerWidth={innerWidth}
          paddingLeft={PADDING.left}
          slotWidth={slotWidth}
          onGestureStart={handleGestureStart}
          onPan={handlePan}
          onZoom={handleZoom}
          onCrosshair={handleCrosshair}
          onGestureEnd={handleGestureEnd}
        >
          <CandlestickChartRenderer
            geometry={geometry}
            candles={renderedCandles}
            currencyCode={currencyCode}
            currentPrice={currentPriceValue}
            currentBullish={parsed[total - 1].bullish}
            crosshair={crosshairState}
            formatTimeLabel={formatSeoulDateTimeLabel}
            firstVisibleTime={parsed[startIndex]?.time ?? null}
            lastVisibleTime={parsed[endIndex - 1]?.time ?? null}
          />
        </CandlestickGestures>
      </View>

      {/* Screen-reader and non-gesture users must be able to drive the chart. */}
      <View style={styles.controls}>
        <Pressable
          style={styles.controlButton}
          onPress={zoomOut}
          accessibilityRole="button"
          accessibilityLabel="차트 축소"
        >
          <Text style={styles.controlText}>−</Text>
        </Pressable>
        <Pressable
          style={styles.controlButton}
          onPress={zoomIn}
          accessibilityRole="button"
          accessibilityLabel="차트 확대"
        >
          <Text style={styles.controlText}>＋</Text>
        </Pressable>
        <Pressable
          style={styles.controlButton}
          onPress={resetToLatest}
          accessibilityRole="button"
          accessibilityLabel="차트를 최신 구간으로 초기화"
        >
          <Text style={styles.controlText}>초기화</Text>
        </Pressable>
        <Text style={styles.controlHint}>
          {endIndex - startIndex}개
          {viewingLatest ? '' : ' · 과거 구간'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { width: '100%' },
  container: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    overflow: 'hidden',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  controlButton: {
    minWidth: 44,
    minHeight: 32,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  controlText: { fontSize: 14, fontWeight: '600', color: '#111' },
  controlHint: { fontSize: 12, color: '#98a2b3' },
});
