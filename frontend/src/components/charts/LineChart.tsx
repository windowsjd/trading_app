import React, { useCallback, useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line as SvgLine, Path } from 'react-native-svg';
import ChartEmptyState from './ChartEmptyState';
import LineChartGestures from './LineChartGestures';
import { formatDisplayDecimal, formatKstDateTime } from '../../utils/format';

export type LineChartPoint = {
  x?: string | number | Date;
  y: string | number;
  label?: string;
};
export type LineChartProps = {
  points: LineChartPoint[];
  height?: number;
  valueFormatter?: (value: number) => string;
  /** Format the original decimal string, without using plot coordinates. */
  pointValueFormatter?: (point: LineChartPoint) => string;
  labelFormatter?: (point: LineChartPoint) => string;
  emptyMessage?: string;
};
const PADDING = 12;

function formatDefaultValue(value: number) {
  return formatDisplayDecimal(value.toFixed(2));
}

function getPointLabel(point: LineChartPoint) {
  if (point.label) return point.label;
  if (point.x instanceof Date) return formatKstDateTime(point.x);
  return point.x === undefined ? '' : String(point.x);
}

export default function LineChart({
  points,
  height = 180,
  valueFormatter = formatDefaultValue,
  pointValueFormatter,
  labelFormatter,
  emptyMessage = '차트 데이터가 충분하지 않습니다.',
}: LineChartProps) {
  const [width, setWidth] = useState(320);
  // Bind selection to the dataset and layout. Account/range changes cannot
  // momentarily show the old point, even before an effect gets to run.
  const [selection, setSelection] = useState<{
    points: LineChartPoint[];
    width: number;
    height: number;
    index: number;
  } | null>(null);
  const coordinates = useMemo(() => {
    const valid = points.flatMap((point) => {
      const value = Number(point.y);
      return Number.isFinite(value) ? [{ point, value }] : [];
    });
    if (valid.length === 0) return [];
    const min = valid.reduce(
      (value, row) => Math.min(value, row.value),
      Infinity,
    );
    const max = valid.reduce(
      (value, row) => Math.max(value, row.value),
      -Infinity,
    );
    const innerWidth = Math.max(width - 2 * PADDING, 1);
    const innerHeight = Math.max(height - 2 * PADDING, 1);
    // All actual points remain selectable. Numbers are only SVG geometry;
    // labels can always use the unmodified source string.
    return valid.map((row, index) => ({
      ...row,
      x:
        PADDING +
        (valid.length === 1 ? 0.5 : index / (valid.length - 1)) * innerWidth,
      y:
        PADDING +
        (max === min ? 0.5 : 1 - (row.value - min) / (max - min)) * innerHeight,
    }));
  }, [points, width, height]);
  const path = useMemo(
    () =>
      coordinates
        .map((point, i) => `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
        .join(' '),
    [coordinates],
  );
  const onSelect = useCallback(
    (x: number | null) => {
      if (x === null || coordinates.length === 0) {
        setSelection(null);
        return;
      }
      const index = coordinates.reduce(
        (best, point, i) =>
          Math.abs(point.x - x) < Math.abs(coordinates[best].x - x) ? i : best,
        0,
      );
      setSelection({ points, width, height, index });
    },
    [coordinates, points, width, height],
  );
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    if (next > 0) setWidth(next);
  };
  if (coordinates.length === 0)
    return <ChartEmptyState message={emptyMessage} />;
  const selected =
    selection?.points === points &&
    selection.width === width &&
    selection.height === height;
  const coordinate =
    coordinates[selected ? selection.index : coordinates.length - 1];
  const label =
    labelFormatter?.(coordinate.point) ?? getPointLabel(coordinate.point);
  const value =
    pointValueFormatter?.(coordinate.point) ?? valueFormatter(coordinate.value);
  return (
    <View
      onLayout={onLayout}
      style={styles.container}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`차트. ${selected ? '선택' : '마지막'} 값 ${label}, ${value}`}
    >
      <Text style={styles.value}>
        {selected ? '선택 값' : '최신 값'} {value}
      </Text>
      <LineChartGestures onSelect={onSelect}>
        <Svg width="100%" height={height}>
          {[0, 0.5, 1].map((ratio) => (
            <SvgLine
              key={ratio}
              x1={PADDING}
              x2={width - PADDING}
              y1={PADDING + ratio * (height - 2 * PADDING)}
              y2={PADDING + ratio * (height - 2 * PADDING)}
              stroke="#eceff3"
            />
          ))}
          <Path
            d={path}
            fill="none"
            stroke="#2563eb"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {selected ? (
            <>
              <SvgLine
                x1={PADDING}
                x2={width - PADDING}
                y1={coordinate.y}
                y2={coordinate.y}
                stroke="#64748b"
                strokeDasharray="4 4"
              />
              <SvgLine
                x1={coordinate.x}
                x2={coordinate.x}
                y1={PADDING}
                y2={height - PADDING}
                stroke="#64748b"
                strokeDasharray="4 4"
              />
            </>
          ) : null}
          <Circle
            cx={coordinate.x}
            cy={coordinate.y}
            r={4}
            fill={selected ? '#2563eb' : '#fff'}
            stroke={selected ? '#fff' : '#2563eb'}
            strokeWidth={2}
          />
        </Svg>
        {selected ? (
          <View
            pointerEvents="none"
            style={[
              styles.guideValue,
              {
                top: Math.max(0, Math.min(coordinate.y - 22, height - 40)),
                ...(coordinate.x < width / 2
                  ? { right: PADDING }
                  : { left: PADDING }),
              },
            ]}
          >
            <Text style={styles.guideValueText}>{value}</Text>
          </View>
        ) : null}
      </LineChartGestures>
      <Text style={styles.date}>{label || '마지막 값'}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  container: { minHeight: 128, gap: 6, minWidth: 0 },
  value: {
    color: '#111',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 21,
    flexShrink: 1,
  },
  date: {
    color: '#666',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    flexShrink: 1,
  },
  guideValue: {
    position: 'absolute',
    maxWidth: '85%',
    backgroundColor: '#eff6ff',
    borderRadius: 4,
    paddingHorizontal: 4,
  },
  guideValueText: {
    color: '#1d4ed8',
    fontSize: 11,
    lineHeight: 18,
    flexShrink: 1,
  },
});
