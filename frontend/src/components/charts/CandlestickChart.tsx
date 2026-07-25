import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  GestureResponderEvent,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { G, Line as SvgLine, Rect, Text as SvgText } from 'react-native-svg';

import { formatCurrency, formatMoney } from '../../utils/format';
import {
  LONG_PRESS_MS,
  adjustViewportForDataChange,
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
  zoomViewportAtPixel,
  type ChartViewport,
} from './chartViewport';
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
   * Changing this key resets the viewport to the default latest-60 window.
   * Pass the timeframe (and asset) identity so a tab switch starts fresh even
   * when React Query serves the new candles from cache without unmounting.
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
// Hard parse cap aligned with the largest single API page (Binance klines:
// 1000). The viewport renders only the visible window + buffer out of these.
const MAX_PARSED_CANDLES = 1000;
const PADDING = { top: 12, right: 66, bottom: 26, left: 8 };
const GRID_LINES = 4;
const LONG_PRESS_MOVE_SLOP_PX = 10;

const UP_COLOR = '#16a34a';
const DOWN_COLOR = '#dc2626';
const GRID_COLOR = '#eef1f4';
const AXIS_TEXT_COLOR = '#98a2b3';
const CROSSHAIR_COLOR = '#64748b';

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

type GestureSession = {
  mode: 'idle' | 'pan' | 'pinch' | 'crosshair';
  startViewport: ChartViewport | null;
  panBaseDx: number;
  pinchStartDistance: number;
  pinchStartViewport: ChartViewport | null;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  touchStart: { x: number; y: number } | null;
};

export default function CandlestickChart({
  candles,
  currencyCode,
  currentPrice,
  height = 240,
  emptyMessage = '표시할 차트 데이터가 없습니다.',
  viewportResetKey,
}: CandlestickChartProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const parsed = useMemo(() => parseCandles(candles), [candles]);
  const [viewport, setViewport] = useState<ChartViewport>(() =>
    createInitialViewport(parsed.length),
  );

  const chartWidth = Math.max(width, 160);
  const innerWidth = Math.max(chartWidth - PADDING.left - PADDING.right, 1);
  const innerHeight = Math.max(height - PADDING.top - PADDING.bottom, 1);

  // Latest values for gesture handlers created once via refs.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const totalRef = useRef(parsed.length);
  totalRef.current = parsed.length;
  const innerWidthRef = useRef(innerWidth);
  innerWidthRef.current = innerWidth;
  const gestureRef = useRef<GestureSession>({
    mode: 'idle',
    startViewport: null,
    panBaseDx: 0,
    pinchStartDistance: 0,
    pinchStartViewport: null,
    longPressTimer: null,
    touchStart: null,
  });

  // Timeframe switches reset to the latest-60 default; data growth while
  // parked at the right edge follows the newest candle, panned-back positions
  // are preserved (item: only the loaded range is ever shown).
  const lastResetKeyRef = useRef(viewportResetKey);
  const prevTotalRef = useRef(parsed.length);
  useEffect(() => {
    const total = parsed.length;
    const keyChanged = lastResetKeyRef.current !== viewportResetKey;
    lastResetKeyRef.current = viewportResetKey;
    const previousTotal = prevTotalRef.current;
    prevTotalRef.current = total;
    setViewport((current) =>
      keyChanged
        ? createInitialViewport(total)
        : adjustViewportForDataChange(current, previousTotal, total),
    );
  }, [parsed.length, viewportResetKey]);

  const onLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.floor(event.nativeEvent.layout.width);
    if (nextWidth > 0 && nextWidth !== width) setWidth(nextWidth);
  };

  const handlePointer = (x: number, y: number) => {
    const clampedX = Math.max(
      PADDING.left,
      Math.min(x, PADDING.left + innerWidthRef.current),
    );
    const clampedY = Math.max(
      PADDING.top,
      Math.min(y, PADDING.top + innerHeight),
    );
    setPointer({ x: clampedX, y: clampedY });
  };

  const clearPointer = () => setPointer(null);

  const clearLongPressTimer = () => {
    const gesture = gestureRef.current;
    if (gesture.longPressTimer) {
      clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = null;
    }
  };

  const endGestureSession = () => {
    const gesture = gestureRef.current;
    clearLongPressTimer();
    if (gesture.mode === 'crosshair') clearPointer();
    gesture.mode = 'idle';
    gesture.startViewport = null;
    gesture.pinchStartViewport = null;
    gesture.pinchStartDistance = 0;
    gesture.touchStart = null;
  };

  const startPinch = (touches: readonly { pageX: number; pageY: number; locationX?: number }[]) => {
    const gesture = gestureRef.current;
    gesture.mode = 'pinch';
    gesture.pinchStartDistance = touchDistance(touches[0], touches[1]);
    gesture.pinchStartViewport = viewportRef.current;
    clearPointer();
  };

  const applyPinch = (
    touches: readonly { pageX: number; pageY: number; locationX?: number }[],
  ) => {
    const gesture = gestureRef.current;
    if (!gesture.pinchStartViewport || gesture.pinchStartDistance <= 0) return;
    const scale = pinchScale(
      touchDistance(touches[0], touches[1]),
      gesture.pinchStartDistance,
    );
    const midLocationX =
      ((touches[0].locationX ?? 0) + (touches[1].locationX ?? 0)) / 2;
    setViewport(
      zoomViewportAtPixel(
        gesture.pinchStartViewport,
        scale,
        midLocationX - PADDING.left,
        innerWidthRef.current,
        totalRef.current,
      ),
    );
  };

  // One PanResponder instance; everything mutable lives in refs.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (event, gestureState) => {
        const gesture = gestureRef.current;
        if (gesture.mode === 'crosshair') return true;
        const touches = event.nativeEvent.touches ?? [];
        if (touches.length >= 2) return true;
        // Vertical single-finger drags stay with the parent ScrollView.
        return isHorizontalPanIntent(gestureState.dx, gestureState.dy);
      },
      onPanResponderGrant: (event, gestureState) => {
        const gesture = gestureRef.current;
        clearLongPressTimer();
        if (gesture.mode === 'crosshair') {
          handlePointer(
            event.nativeEvent.locationX,
            event.nativeEvent.locationY,
          );
          return;
        }
        const touches = event.nativeEvent.touches ?? [];
        if (touches.length >= 2) {
          startPinch(touches);
          return;
        }
        gesture.mode = 'pan';
        gesture.startViewport = viewportRef.current;
        gesture.panBaseDx = gestureState.dx;
      },
      onPanResponderMove: (event, gestureState) => {
        const gesture = gestureRef.current;
        if (gesture.mode === 'crosshair') {
          handlePointer(
            event.nativeEvent.locationX,
            event.nativeEvent.locationY,
          );
          return;
        }
        const touches = event.nativeEvent.touches ?? [];
        if (touches.length >= 2) {
          if (gesture.mode !== 'pinch') {
            startPinch(touches);
          } else {
            applyPinch(touches);
          }
          return;
        }
        if (gesture.mode === 'pinch') {
          // One finger lifted mid-pinch: continue as a pan from here.
          gesture.mode = 'pan';
          gesture.startViewport = viewportRef.current;
          gesture.panBaseDx = gestureState.dx;
          return;
        }
        if (gesture.mode !== 'pan' || !gesture.startViewport) return;
        setViewport(
          panViewportByPixels(
            gesture.startViewport,
            gestureState.dx - gesture.panBaseDx,
            innerWidthRef.current,
            totalRef.current,
          ),
        );
      },
      onPanResponderRelease: endGestureSession,
      onPanResponderTerminate: endGestureSession,
      // Never hand an ACTIVE pan/pinch/crosshair back to the ScrollView.
      onPanResponderTerminationRequest: () =>
        gestureRef.current.mode === 'idle',
    }),
  ).current;

  // Long-press (touch only): held still past the delay → crosshair mode. The
  // raw touch handlers fire alongside the responder system, so the timer can
  // arm before any responder claim happens.
  const onTouchStart = (event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches ?? [];
    const gesture = gestureRef.current;
    if (touches.length !== 1) {
      clearLongPressTimer();
      return;
    }
    const { locationX, locationY } = event.nativeEvent;
    gesture.touchStart = { x: locationX, y: locationY };
    clearLongPressTimer();
    gesture.longPressTimer = setTimeout(() => {
      gesture.longPressTimer = null;
      if (gesture.mode !== 'idle' || !gesture.touchStart) return;
      gesture.mode = 'crosshair';
      handlePointer(gesture.touchStart.x, gesture.touchStart.y);
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (event: GestureResponderEvent) => {
    const gesture = gestureRef.current;
    if (!gesture.touchStart || gesture.mode !== 'idle') return;
    const { locationX, locationY } = event.nativeEvent;
    const movedFar =
      Math.hypot(
        locationX - gesture.touchStart.x,
        locationY - gesture.touchStart.y,
      ) > LONG_PRESS_MOVE_SLOP_PX;
    // Movement before the delay elapses means pan/scroll, not a long-press.
    if (movedFar) clearLongPressTimer();
  };

  const onTouchEndOrCancel = (event: GestureResponderEvent) => {
    if ((event.nativeEvent.touches ?? []).length > 0) return;
    endGestureSession();
  };

  // Web: wheel / trackpad zoom anchored at the cursor. react-native-web View
  // refs expose the DOM element, so a non-passive listener can preventDefault
  // the page scroll while zooming.
  const containerRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = containerRef.current as unknown as
      | (HTMLElement & {
          addEventListener: HTMLElement['addEventListener'];
        })
      | null;
    if (!node?.addEventListener) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const pixelX = event.clientX - rect.left - PADDING.left;
      setViewport((current) =>
        zoomViewportAtPixel(
          current,
          wheelZoomScale(event.deltaY),
          pixelX,
          innerWidthRef.current,
          totalRef.current,
        ),
      );
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  // Web: hover crosshair (suppressed while dragging).
  const webHoverProps: Record<string, unknown> =
    Platform.OS === 'web'
      ? {
          onMouseMove: (event: {
            clientX: number;
            clientY: number;
            currentTarget: {
              getBoundingClientRect: () => { left: number; top: number };
            };
          }) => {
            if (gestureRef.current.mode === 'pan') {
              clearPointer();
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            handlePointer(event.clientX - rect.left, event.clientY - rect.top);
          },
          onMouseLeave: clearPointer,
        }
      : {};

  const geometry = useMemo(() => {
    if (parsed.length === 0) return null;
    const total = parsed.length;
    const strict = strictVisibleIndexRange(viewport, total);
    if (strict.endExclusive <= strict.start) return null;

    const { slotWidth, bodyWidth } = viewportSlotLayout(
      innerWidth,
      viewport.size,
    );
    const lastCandle = parsed[total - 1];
    const latestVisible = strict.endExclusive >= total;
    const livePrice = toNumber(currentPrice ?? null);
    const currentPriceValue = livePrice ?? lastCandle.close;

    // Y-axis from the candles ACTUALLY on screen (strict window, no buffer);
    // the current price participates only while the latest candle is visible.
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = strict.start; index < strict.endExclusive; index += 1) {
      const candle = parsed[index];
      if (candle.low < minY) minY = candle.low;
      if (candle.high > maxY) maxY = candle.high;
    }
    if (latestVisible && Number.isFinite(currentPriceValue)) {
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

    const xForIndex = (index: number) =>
      xCenterForIndex(index, viewport, innerWidth, PADDING.left);
    const yForPrice = (price: number) =>
      PADDING.top + (1 - (price - minY) / range) * innerHeight;
    const priceForY = (y: number) =>
      minY + (1 - (y - PADDING.top) / innerHeight) * range;

    return {
      strict,
      rendered: visibleIndexRange(viewport, total),
      slotWidth,
      bodyWidth,
      minY,
      maxY,
      range,
      latestVisible,
      currentPriceValue,
      currentBullish: lastCandle.bullish,
      xForIndex,
      yForPrice,
      priceForY,
    };
  }, [parsed, viewport, innerWidth, innerHeight, currentPrice]);

  // Candle and grid nodes are memoized so crosshair moves (pointer state) do
  // not rebuild them; only pan/zoom (viewport) and data changes do. Only the
  // visible window + buffer is materialized as SVG nodes.
  const candleNodes = useMemo(() => {
    if (!geometry) return null;
    const { rendered, bodyWidth, xForIndex, yForPrice } = geometry;
    const nodes = [] as React.ReactElement[];
    for (let index = rendered.start; index < rendered.endExclusive; index += 1) {
      const candle = parsed[index];
      const x = xForIndex(index);
      const color = candle.bullish ? UP_COLOR : DOWN_COLOR;
      const highY = yForPrice(candle.high);
      const lowY = yForPrice(candle.low);
      const openY = yForPrice(candle.open);
      const closeY = yForPrice(candle.close);
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(Math.abs(openY - closeY), 1);
      nodes.push(
        <G key={`candle-${parsed[index].time}`}>
          <SvgLine
            x1={x}
            y1={highY}
            x2={x}
            y2={lowY}
            stroke={color}
            strokeWidth={1}
          />
          <Rect
            x={x - bodyWidth / 2}
            y={bodyTop}
            width={bodyWidth}
            height={bodyHeight}
            fill={color}
            rx={0.5}
          />
        </G>,
      );
    }
    return nodes;
  }, [parsed, geometry]);

  const gridNodes = useMemo(() => {
    if (!geometry) return null;
    const { minY, range, yForPrice } = geometry;
    const rightX = PADDING.left + innerWidth;
    return Array.from({ length: GRID_LINES + 1 }, (_, index) => {
      const value = minY + (range * index) / GRID_LINES;
      const y = yForPrice(value);
      return (
        <G key={`grid-${index}`}>
          <SvgLine
            x1={PADDING.left}
            y1={y}
            x2={rightX}
            y2={y}
            stroke={GRID_COLOR}
            strokeWidth={1}
          />
          <SvgText
            x={rightX + 4}
            y={y + 3}
            fontSize={9}
            fill={AXIS_TEXT_COLOR}
          >
            {formatCurrency(value, currencyCode)}
          </SvgText>
        </G>
      );
    });
  }, [geometry, currencyCode, innerWidth]);

  if (parsed.length < 1 || !geometry) {
    return <ChartEmptyState message={emptyMessage} />;
  }

  const {
    strict,
    latestVisible,
    currentPriceValue,
    currentBullish,
    xForIndex,
    yForPrice,
    priceForY,
  } = geometry;

  const rightEdgeX = PADDING.left + innerWidth;
  const bottomY = PADDING.top + innerHeight;
  const currentColor = currentBullish ? UP_COLOR : DOWN_COLOR;
  const currentPriceY = yForPrice(currentPriceValue);
  const showCurrentPriceLine =
    latestVisible &&
    currentPriceY >= PADDING.top - 1 &&
    currentPriceY <= bottomY + 1;

  // Crosshair: vertical snaps to the nearest visible candle; horizontal is
  // free at the pointer.
  let crosshair: {
    x: number;
    y: number;
    price: number;
    timeLabel: string;
  } | null = null;
  if (pointer) {
    const index = indexForPixel(
      pointer.x,
      viewport,
      innerWidth,
      PADDING.left,
      parsed.length,
    );
    if (index !== null) {
      crosshair = {
        x: xForIndex(index),
        y: pointer.y,
        price: priceForY(pointer.y),
        timeLabel: formatSeoulDateTimeLabel(parsed[index].time),
      };
    }
  }

  const firstLabel = formatSeoulDateTimeLabel(parsed[strict.start].time);
  const lastLabel = formatSeoulDateTimeLabel(
    parsed[strict.endExclusive - 1].time,
  );

  return (
    <View
      ref={containerRef}
      onLayout={onLayout}
      style={[styles.container, { height }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`캔들 차트. 현재가 ${formatMoney(currentPriceValue, currencyCode)}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEndOrCancel}
      onTouchCancel={onTouchEndOrCancel}
      {...panResponder.panHandlers}
      {...webHoverProps}
    >
      <Svg width="100%" height={height}>
        {/* Grid + right-axis price labels (memoized) */}
        {gridNodes}

        {/* Candles (memoized; visible window + buffer only) */}
        {candleNodes}

        {/* Current-price dashed line + colored label (latest candle on screen) */}
        {showCurrentPriceLine ? (
          <G>
            <SvgLine
              x1={PADDING.left}
              y1={currentPriceY}
              x2={rightEdgeX}
              y2={currentPriceY}
              stroke={currentColor}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <Rect
              x={rightEdgeX}
              y={currentPriceY - 8}
              width={PADDING.right}
              height={16}
              fill={currentColor}
              rx={2}
            />
            <SvgText
              x={rightEdgeX + 4}
              y={currentPriceY + 3}
              fontSize={9}
              fontWeight="bold"
              fill="#ffffff"
            >
              {formatMoney(currentPriceValue, currencyCode)}
            </SvgText>
          </G>
        ) : null}

        {/* Crosshair */}
        {crosshair ? (
          <G>
            <SvgLine
              x1={crosshair.x}
              y1={PADDING.top}
              x2={crosshair.x}
              y2={bottomY}
              stroke={CROSSHAIR_COLOR}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <SvgLine
              x1={PADDING.left}
              y1={crosshair.y}
              x2={rightEdgeX}
              y2={crosshair.y}
              stroke={CROSSHAIR_COLOR}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            {/* Pointer price label (right) */}
            <Rect
              x={rightEdgeX}
              y={crosshair.y - 8}
              width={PADDING.right}
              height={16}
              fill={CROSSHAIR_COLOR}
              rx={2}
            />
            <SvgText
              x={rightEdgeX + 4}
              y={crosshair.y + 3}
              fontSize={9}
              fontWeight="bold"
              fill="#ffffff"
            >
              {formatMoney(crosshair.price, currencyCode)}
            </SvgText>
            {/* Pointer time label (bottom) */}
            <Rect
              x={Math.max(
                PADDING.left,
                Math.min(crosshair.x - 62, rightEdgeX - 124),
              )}
              y={bottomY + 4}
              width={124}
              height={16}
              fill={CROSSHAIR_COLOR}
              rx={2}
            />
            <SvgText
              x={Math.max(
                PADDING.left + 62,
                Math.min(crosshair.x, rightEdgeX - 62),
              )}
              y={bottomY + 15}
              fontSize={9}
              fontWeight="bold"
              fill="#ffffff"
              textAnchor="middle"
            >
              {crosshair.timeLabel}
            </SvgText>
          </G>
        ) : (
          // Minimal static x-axis context: first / last VISIBLE candle time.
          <G>
            <SvgText
              x={PADDING.left}
              y={bottomY + 15}
              fontSize={9}
              fill={AXIS_TEXT_COLOR}
            >
              {firstLabel}
            </SvgText>
            <SvgText
              x={rightEdgeX}
              y={bottomY + 15}
              fontSize={9}
              fill={AXIS_TEXT_COLOR}
              textAnchor="end"
            >
              {lastLabel}
            </SvgText>
          </G>
        )}
      </Svg>
      {!latestVisible && !isAtLatestEdge(viewport, parsed.length) ? (
        // Subtle hint that history mode is active (latest candle off screen).
        <View style={styles.historyBadge} pointerEvents="none">
          <SvgBadge />
        </View>
      ) : null}
    </View>
  );
}

/** Tiny "history mode" marker: a right-pointing chevron in a pill. */
function SvgBadge() {
  return (
    <Svg width={22} height={22}>
      <Rect x={0} y={0} width={22} height={22} rx={11} fill="#0f172a66" />
      <SvgLine x1={8} y1={6} x2={15} y2={11} stroke="#ffffff" strokeWidth={2} />
      <SvgLine x1={15} y1={11} x2={8} y2={16} stroke="#ffffff" strokeWidth={2} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    overflow: 'hidden',
  },
  historyBadge: {
    position: 'absolute',
    right: PADDING.right + 4,
    top: 8,
  },
});
