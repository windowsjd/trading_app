import React, { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Line as SvgLine,
  Path,
} from 'react-native-svg';

import ChartEmptyState from './ChartEmptyState';

export type LineChartPoint = {
  x?: string | number | Date;
  y: string | number;
  label?: string;
};

export type LineChartProps = {
  points: LineChartPoint[];
  height?: number;
  valueFormatter?: (value: number) => string;
  labelFormatter?: (point: LineChartPoint) => string;
  emptyMessage?: string;
};

type SanitizedPoint = {
  point: LineChartPoint;
  y: number;
};

const DEFAULT_WIDTH = 320;
const MAX_POINTS = 80;
const PADDING = {
  top: 16,
  right: 12,
  bottom: 16,
  left: 12,
};

function parseDecimal(value: string | number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDefaultValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function downsample(points: SanitizedPoint[], maxPoints: number) {
  if (points.length <= maxPoints) return points;

  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex =
      index === maxPoints - 1 ? points.length - 1 : Math.floor(index * step);
    return points[sourceIndex];
  });
}

function getPointLabel(point: LineChartPoint) {
  if (point.label) return point.label;
  if (point.x instanceof Date) return point.x.toISOString();
  if (point.x !== undefined) return String(point.x);
  return '';
}

export default function LineChart({
  points,
  height = 180,
  valueFormatter = formatDefaultValue,
  labelFormatter,
  emptyMessage = '차트 데이터가 충분하지 않습니다.',
}: LineChartProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  const sanitizedPoints = useMemo(
    () =>
      points
        .map((point) => {
          const y = parseDecimal(point.y);
          return y === null ? null : { point, y };
        })
        .filter((point): point is SanitizedPoint => point !== null),
    [points],
  );

  const chartPoints = useMemo(
    () => downsample(sanitizedPoints, MAX_POINTS),
    [sanitizedPoints],
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.floor(event.nativeEvent.layout.width);
    if (nextWidth > 0 && nextWidth !== width) {
      setWidth(nextWidth);
    }
  };

  if (sanitizedPoints.length < 2) {
    return <ChartEmptyState message={emptyMessage} />;
  }

  const values = chartPoints.map((point) => point.y);
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const isFlat = minY === maxY;
  const chartWidth = Math.max(width, 120);
  const innerWidth = Math.max(chartWidth - PADDING.left - PADDING.right, 1);
  const innerHeight = Math.max(height - PADDING.top - PADDING.bottom, 1);
  const yRange = isFlat ? 1 : maxY - minY;

  const coordinates = chartPoints.map((point, index) => {
    const x =
      chartPoints.length === 1
        ? PADDING.left + innerWidth / 2
        : PADDING.left + (index / (chartPoints.length - 1)) * innerWidth;
    const y = isFlat
      ? PADDING.top + innerHeight / 2
      : PADDING.top + (1 - (point.y - minY) / yRange) * innerHeight;

    return { x, y, value: point.y, point: point.point };
  });

  const linePath = coordinates
    .map((coordinate, index) =>
      `${index === 0 ? 'M' : 'L'} ${coordinate.x.toFixed(2)} ${coordinate.y.toFixed(2)}`,
    )
    .join(' ');
  const lastCoordinate = coordinates[coordinates.length - 1];
  const lastLabel =
    labelFormatter?.(lastCoordinate.point) ?? getPointLabel(lastCoordinate.point);
  const lastValue = valueFormatter(lastCoordinate.value);
  const accessibilityLabel = lastLabel
    ? `차트. 마지막 값 ${lastLabel}, ${lastValue}`
    : `차트. 마지막 값 ${lastValue}`;

  return (
    <View
      onLayout={onLayout}
      style={styles.container}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Svg width="100%" height={height}>
        <SvgLine
          x1={PADDING.left}
          y1={PADDING.top}
          x2={PADDING.left + innerWidth}
          y2={PADDING.top}
          stroke="#eceff3"
          strokeWidth={1}
        />
        <SvgLine
          x1={PADDING.left}
          y1={PADDING.top + innerHeight / 2}
          x2={PADDING.left + innerWidth}
          y2={PADDING.top + innerHeight / 2}
          stroke="#eceff3"
          strokeWidth={1}
        />
        <SvgLine
          x1={PADDING.left}
          y1={PADDING.top + innerHeight}
          x2={PADDING.left + innerWidth}
          y2={PADDING.top + innerHeight}
          stroke="#eceff3"
          strokeWidth={1}
        />
        <Path
          d={linePath}
          fill="none"
          stroke="#2563eb"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {isFlat ? (
          <SvgLine
            x1={PADDING.left}
            y1={PADDING.top + innerHeight / 2}
            x2={PADDING.left + innerWidth}
            y2={PADDING.top + innerHeight / 2}
            stroke="#93c5fd"
            strokeWidth={1}
            strokeDasharray="5 5"
          />
        ) : null}
        <Circle
          cx={lastCoordinate.x}
          cy={lastCoordinate.y}
          r={5}
          fill="#fff"
          stroke="#2563eb"
          strokeWidth={3}
        />
      </Svg>
      <View style={styles.footer}>
        <Text style={styles.footerLabel} numberOfLines={1}>
          {lastLabel || '마지막 값'}
        </Text>
        <Text style={styles.footerValue} numberOfLines={1}>
          {lastValue}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 128,
    gap: 6,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  footerLabel: {
    flex: 1,
    color: '#666',
    fontSize: 12,
  },
  footerValue: {
    color: '#111',
    fontSize: 14,
    fontWeight: '700',
  },
});
