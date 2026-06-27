import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import ChartEmptyState from './ChartEmptyState';

export type DonutChartSegment = {
  key: string;
  label: string;
  value: string | number;
};

export type DonutChartProps = {
  segments: DonutChartSegment[];
  size?: number;
  thickness?: number;
  valueFormatter?: (value: number) => string;
  emptyMessage?: string;
};

const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed'];

function parseDecimal(value: string | number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDefaultValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export default function DonutChart({
  segments,
  size = 176,
  thickness = 22,
  valueFormatter = formatDefaultValue,
  emptyMessage = '자산 배분 데이터가 없습니다.',
}: DonutChartProps) {
  const sanitizedSegments = useMemo(
    () =>
      segments
        .map((segment, index) => {
          const value = parseDecimal(segment.value);
          return value !== null && value > 0
            ? {
                ...segment,
                value,
                color: PALETTE[index % PALETTE.length],
              }
            : null;
        })
        .filter(
          (
            segment,
          ): segment is DonutChartSegment & { value: number; color: string } =>
            segment !== null,
        ),
    [segments],
  );

  const total = sanitizedSegments.reduce(
    (sum, segment) => sum + segment.value,
    0,
  );

  if (total <= 0) {
    return <ChartEmptyState message={emptyMessage} />;
  }

  const safeSize = Math.max(size, 120);
  const safeThickness = Math.min(Math.max(thickness, 12), safeSize / 3);
  const radius = (safeSize - safeThickness) / 2;
  const center = safeSize / 2;
  const circumference = 2 * Math.PI * radius;
  let accumulated = 0;

  return (
    <View
      style={styles.container}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`도넛 차트. 총 ${valueFormatter(total)}`}
    >
      <View style={styles.chartRow}>
        <View style={{ width: safeSize, height: safeSize }}>
          <Svg width={safeSize} height={safeSize}>
            <Circle
              cx={center}
              cy={center}
              r={radius}
              stroke="#eef0f3"
              strokeWidth={safeThickness}
              fill="none"
            />
            {sanitizedSegments.map((segment) => {
              const arcLength = (segment.value / total) * circumference;
              const dashOffset = -accumulated;
              accumulated += arcLength;

              return (
                <Circle
                  key={segment.key}
                  cx={center}
                  cy={center}
                  r={radius}
                  stroke={segment.color}
                  strokeWidth={safeThickness}
                  fill="none"
                  strokeDasharray={`${arcLength} ${circumference - arcLength}`}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="butt"
                  originX={center}
                  originY={center}
                  rotation="-90"
                />
              );
            })}
          </Svg>
          <View style={styles.centerLabel}>
            <Text style={styles.centerTitle}>총계</Text>
            <Text style={styles.centerValue} numberOfLines={1}>
              {valueFormatter(total)}
            </Text>
          </View>
        </View>

        <View style={styles.legend}>
          {sanitizedSegments.map((segment) => {
            const percentage = (segment.value / total) * 100;

            return (
              <View key={segment.key} style={styles.legendRow}>
                <View
                  style={[styles.swatch, { backgroundColor: segment.color }]}
                />
                <View style={styles.legendTextWrap}>
                  <Text style={styles.legendLabel} numberOfLines={1}>
                    {segment.label}
                  </Text>
                  <Text style={styles.legendValue} numberOfLines={1}>
                    {valueFormatter(segment.value)} · {percentage.toFixed(1)}%
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
  },
  chartRow: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  centerLabel: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  centerTitle: {
    color: '#777',
    fontSize: 12,
  },
  centerValue: {
    color: '#111',
    fontSize: 14,
    fontWeight: '700',
    maxWidth: 96,
  },
  legend: {
    flex: 1,
    minWidth: 140,
    gap: 10,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendTextWrap: {
    flex: 1,
  },
  legendLabel: {
    color: '#222',
    fontSize: 13,
    fontWeight: '700',
  },
  legendValue: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
  },
});
