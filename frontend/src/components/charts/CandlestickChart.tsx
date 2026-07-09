import React, { useMemo, useState } from 'react';
import {
  LayoutChangeEvent,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { G, Line as SvgLine, Rect, Text as SvgText } from 'react-native-svg';

import { formatCurrency, formatMoney } from '../../utils/format';
import {
  candleIndexForX,
  candleXCenter,
  computeCandleXLayout,
} from './candlestickLayout';
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
const MAX_CANDLES = 120;
const PADDING = { top: 12, right: 66, bottom: 26, left: 8 };
const GRID_LINES = 4;

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
  return parsed.length > MAX_CANDLES ? parsed.slice(-MAX_CANDLES) : parsed;
}

export default function CandlestickChart({
  candles,
  currencyCode,
  currentPrice,
  height = 240,
  emptyMessage = '표시할 차트 데이터가 없습니다.',
}: CandlestickChartProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const parsed = useMemo(() => parseCandles(candles), [candles]);

  const onLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.floor(event.nativeEvent.layout.width);
    if (nextWidth > 0 && nextWidth !== width) setWidth(nextWidth);
  };

  const geometry = useMemo(() => {
    if (parsed.length === 0) return null;

    const chartWidth = Math.max(width, 160);
    const innerWidth = Math.max(chartWidth - PADDING.left - PADDING.right, 1);
    const innerHeight = Math.max(height - PADDING.top - PADDING.bottom, 1);
    // Right-align a sparse candle series instead of over-spreading it; use full
    // width once there are enough candles. See computeCandleXLayout.
    const { slotWidth, bodyWidth, xStart } = computeCandleXLayout(
      parsed.length,
      innerWidth,
      PADDING.left,
    );

    const livePrice = toNumber(currentPrice ?? null);
    const lastCandle = parsed[parsed.length - 1];
    const currentPriceValue = livePrice ?? lastCandle.close;

    let minY = Math.min(...parsed.map((c) => c.low));
    let maxY = Math.max(...parsed.map((c) => c.high));
    if (Number.isFinite(currentPriceValue)) {
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
      candleXCenter(xStart, slotWidth, index);
    const yForPrice = (price: number) =>
      PADDING.top + (1 - (price - minY) / range) * innerHeight;
    const priceForY = (y: number) =>
      minY + (1 - (y - PADDING.top) / innerHeight) * range;

    return {
      chartWidth,
      innerWidth,
      innerHeight,
      slotWidth,
      bodyWidth,
      xStart,
      minY,
      maxY,
      range,
      currentPriceValue,
      currentBullish: lastCandle.bullish,
      xForIndex,
      yForPrice,
      priceForY,
    };
  }, [parsed, width, height, currentPrice]);

  const handlePointer = (x: number, y: number) => {
    if (!geometry) return;
    const clampedX = Math.max(
      PADDING.left,
      Math.min(x, PADDING.left + geometry.innerWidth),
    );
    const clampedY = Math.max(
      PADDING.top,
      Math.min(y, PADDING.top + geometry.innerHeight),
    );
    setPointer({ x: clampedX, y: clampedY });
  };

  const clearPointer = () => setPointer(null);

  // Touch (native + web touch): use the responder system. We grab the touch to
  // scrub the crosshair, but let a parent ScrollView reclaim it for vertical
  // scrolling so the chart never traps the page scroll.
  const responderProps = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => true,
    onResponderGrant: (event: {
      nativeEvent: { locationX: number; locationY: number };
    }) => handlePointer(event.nativeEvent.locationX, event.nativeEvent.locationY),
    onResponderMove: (event: {
      nativeEvent: { locationX: number; locationY: number };
    }) => handlePointer(event.nativeEvent.locationX, event.nativeEvent.locationY),
    onResponderRelease: clearPointer,
    onResponderTerminate: clearPointer,
  };

  // Mouse hover (web only): react-native-web forwards these DOM handlers.
  const webHoverProps: Record<string, unknown> =
    Platform.OS === 'web'
      ? {
          onMouseMove: (event: {
            clientX: number;
            clientY: number;
            currentTarget: { getBoundingClientRect: () => { left: number; top: number } };
          }) => {
            const rect = event.currentTarget.getBoundingClientRect();
            handlePointer(event.clientX - rect.left, event.clientY - rect.top);
          },
          onMouseLeave: clearPointer,
        }
      : {};

  if (parsed.length < 1 || !geometry) {
    return <ChartEmptyState message={emptyMessage} />;
  }

  const {
    innerWidth,
    innerHeight,
    bodyWidth,
    minY,
    range,
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

  const gridValues = Array.from({ length: GRID_LINES + 1 }, (_, i) =>
    minY + (range * i) / GRID_LINES,
  );

  // Crosshair: vertical snaps to the nearest candle; horizontal is free at the pointer.
  let crosshair: {
    x: number;
    y: number;
    price: number;
    timeLabel: string;
  } | null = null;
  if (pointer) {
    // Snaps to the nearest candle; empty left area snaps to the first candle.
    const index = candleIndexForX(
      geometry.xStart,
      geometry.slotWidth,
      pointer.x,
      parsed.length,
    );
    crosshair = {
      x: xForIndex(index),
      y: pointer.y,
      price: priceForY(pointer.y),
      timeLabel: formatSeoulDateTimeLabel(parsed[index].time),
    };
  }

  const firstLabel = formatSeoulDateTimeLabel(parsed[0].time);
  const lastLabel = formatSeoulDateTimeLabel(parsed[parsed.length - 1].time);

  return (
    <View
      onLayout={onLayout}
      style={[styles.container, { height }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`캔들 차트. 현재가 ${formatMoney(currentPriceValue, currencyCode)}`}
      {...responderProps}
      {...webHoverProps}
    >
      <Svg width="100%" height={height}>
        {/* Grid + right-axis price labels */}
        {gridValues.map((value, index) => {
          const y = yForPrice(value);
          return (
            <G key={`grid-${index}`}>
              <SvgLine
                x1={PADDING.left}
                y1={y}
                x2={rightEdgeX}
                y2={y}
                stroke={GRID_COLOR}
                strokeWidth={1}
              />
              <SvgText
                x={rightEdgeX + 4}
                y={y + 3}
                fontSize={9}
                fill={AXIS_TEXT_COLOR}
              >
                {formatCurrency(value, currencyCode)}
              </SvgText>
            </G>
          );
        })}

        {/* Candles */}
        {parsed.map((candle, index) => {
          const x = xForIndex(index);
          const color = candle.bullish ? UP_COLOR : DOWN_COLOR;
          const highY = yForPrice(candle.high);
          const lowY = yForPrice(candle.low);
          const openY = yForPrice(candle.open);
          const closeY = yForPrice(candle.close);
          const bodyTop = Math.min(openY, closeY);
          const bodyHeight = Math.max(Math.abs(openY - closeY), 1);
          return (
            <G key={`candle-${index}`}>
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
            </G>
          );
        })}

        {/* Current-price dashed line + colored label */}
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
          // Minimal static x-axis context (first / last candle time)
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    overflow: 'hidden',
  },
});
