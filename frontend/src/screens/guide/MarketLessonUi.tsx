import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline, Rect } from 'react-native-svg';
import { UP_COLOR, DOWN_COLOR } from '../../components/charts/candleColors';
import { LessonAction, lessonStyles as s } from './LessonUi';
import { won, type Ohlc } from './lessonCalculations';

export function Choices<T extends string | number>({
  id,
  options,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={s.choices}>
      {options.map((option) => (
        <LessonAction
          key={option.value}
          id={`${id}-${option.value}`}
          label={option.label}
          selected={value === option.value}
          secondary={value !== option.value}
          disabled={disabled}
          onPress={() => onChange(option.value)}
        />
      ))}
    </View>
  );
}
export function Metric({
  label,
  value,
  id,
}: {
  label: string;
  value: string;
  id?: string;
}) {
  return (
    <View
      testID={id}
      style={s.section}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text style={s.helper}>{label}</Text>
      <Text style={[s.body, s.bold]}>{value}</Text>
    </View>
  );
}
export function Basis({ children }: React.PropsWithChildren) {
  return <Text style={s.helper}>{children}</Text>;
}
export function Values({
  rows,
  id,
}: {
  rows: readonly (readonly [string, string])[];
  id?: string;
}) {
  return (
    <View style={s.card} testID={id}>
      {rows.map(([label, value]) => (
        <Metric key={label} label={label} value={value} />
      ))}
    </View>
  );
}
const y = (value: number, domain: readonly [number, number]) =>
  180 - ((value - domain[0]) / (domain[1] - domain[0])) * 160;
const x = (index: number, count: number) =>
  count < 2 ? 150 : 24 + (index / (count - 1)) * 252;

export function LessonPlot({
  id,
  series,
  labels,
  domain,
  unit = '원',
}: {
  id: string;
  series: { name: string; values: (number | null)[] }[];
  labels: string[];
  domain: [number, number];
  unit?: string;
}) {
  const colors = ['#245b76', '#995b16'];
  return (
    <View style={s.card} testID={id}>
      <Svg width="100%" height={200} viewBox="0 0 300 200" accessible={false}>
        <Line x1={24} x2={276} y1={180} y2={180} stroke="#c5ced2" />
        {series.flatMap((line, j) => {
          const segments: string[][] = [[]];
          line.values.forEach((value, i) => {
            if (value === null) segments.push([]);
            else
              segments[segments.length - 1].push(
                `${x(i, labels.length)},${y(value, domain)}`,
              );
          });
          return [
            ...segments
              .filter((segment) => segment.length > 1)
              .map((points, i) => (
                <Polyline
                  key={`${j}-line-${i}`}
                  testID={`${id}-line-${j}-${i}`}
                  points={points.join(' ')}
                  stroke={colors[j % colors.length]}
                  strokeWidth={3}
                  fill="none"
                />
              )),
            ...line.values.flatMap((value, i) =>
              value === null
                ? []
                : [
                    <Circle
                      key={`${j}-${i}`}
                      cx={x(i, labels.length)}
                      cy={y(value, domain)}
                      r={4}
                      fill={colors[j % colors.length]}
                    />,
                  ],
            ),
          ];
        })}
      </Svg>
      <Basis>
        공통 세로축:{' '}
        {domain[0].toLocaleString('ko-KR', { maximumFractionDigits: 2 })}~
        {domain[1].toLocaleString('ko-KR', { maximumFractionDigits: 2 })}
        {unit}
      </Basis>
      {series.map((line, index) => (
        <View key={line.name} style={s.section}>
          <Text
            style={[s.body, s.bold, { color: colors[index % colors.length] }]}
          >
            {line.name}
          </Text>
          {line.values.map((value, i) => (
            <Text key={i} style={s.body}>
              {labels[i]}:{' '}
              {value === null
                ? '거래 기록 없음 · 공백'
                : `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${unit}`}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}
export function CandleSeries({
  id,
  items,
  domain,
}: {
  id: string;
  items: { label: string; candle: Ohlc | null }[];
  domain: [number, number];
}) {
  return (
    <View style={s.card} testID={id}>
      <Svg width="100%" height={210} viewBox="0 0 300 210" accessible={false}>
        <Line x1={10} x2={10} y1={20} y2={180} stroke="#c5ced2" />
        {[20, 100, 180].map((level) => (
          <Line
            key={level}
            x1={10}
            x2={290}
            y1={level}
            y2={level}
            stroke="#eef1f3"
          />
        ))}
        {items.map(({ candle }, i) => {
          const center = ((i + 0.5) / items.length) * 300;
          if (!candle)
            return (
              <Rect
                key={i}
                x={center - 22}
                y={20}
                width={44}
                height={160}
                fill="#eef1f3"
              />
            );
          const color = candle.close >= candle.open ? UP_COLOR : DOWN_COLOR;
          return (
            <React.Fragment key={i}>
              <Line
                x1={center}
                x2={center}
                y1={y(candle.high, domain)}
                y2={y(candle.low, domain)}
                stroke={color}
                strokeWidth={3}
              />
              <Rect
                testID={`${id}-body-${i}`}
                x={center - 16}
                y={y(Math.max(candle.open, candle.close), domain)}
                width={32}
                height={Math.max(
                  1,
                  Math.abs(y(candle.open, domain) - y(candle.close, domain)),
                )}
                fill={color}
              />
            </React.Fragment>
          );
        })}
      </Svg>
      <Basis>
        공통 가격축: {won(domain[0])}~{won(domain[1])} · 양봉 녹색 / 음봉 빨간색
      </Basis>
      {items.map(({ label, candle }, i) => (
        <View
          key={i}
          style={s.section}
          accessible
          accessibilityLabel={
            candle
              ? `${label}, ${candle.close < candle.open ? '음봉' : candle.close > candle.open ? '양봉' : '시가와 종가 동일'}, 시가 ${won(candle.open)}, 고가 ${won(candle.high)}, 저가 ${won(candle.low)}, 종가 ${won(candle.close)}`
              : `${label}, 거래 기록 없음`
          }
        >
          <Text style={[s.body, s.bold]}>{label}</Text>
          <Text style={s.body}>
            {candle
              ? `${candle.close < candle.open ? '음봉' : candle.close > candle.open ? '양봉' : '시가와 종가 동일'}\n시가 ${won(candle.open)}\n고가 ${won(candle.high)}\n저가 ${won(candle.low)}\n종가 ${won(candle.close)}`
              : '거래 기록 없음 · 공백'}
          </Text>
        </View>
      ))}
    </View>
  );
}
