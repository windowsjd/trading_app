import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Line, Polyline, Rect } from 'react-native-svg';
import { candleParts, won, type Ohlc } from './lessonCalculations';
import { lessonStyles as s } from './LessonUi';
import { UP_COLOR, DOWN_COLOR } from '../../components/charts/candleColors';

// All teaching candles share a price scale so their shapes are comparable.
const y = (price: number) => 190 - ((price - 9400) / 1600) * 170;
// Native text determines row height: the connected candle grows with font scaling.
// Each leader touches the exact point/range described by that row, without a color key.
const anatomy = [
  {
    id: 'high',
    label: '고가 (High) · 10,600원',
    meaning: '이 시간 구간에서 체결된 가격 중 가장 높은 가격.',
    top: '50%',
    bottom: 0,
    body: false,
  },
  {
    id: 'upper',
    label: '윗꼬리 (Upper Wick)',
    meaning: '몸통의 위쪽 끝에서 고가까지의 가격 범위.',
    top: 0,
    bottom: 0,
    body: false,
  },
  {
    id: 'close',
    label: '종가 (Close) · 10,400원',
    meaning: '이 시간 구간에서 마지막으로 거래가 체결된 가격.',
    top: 0,
    bottom: 0,
    body: true,
  },
  {
    id: 'body',
    label: '몸통 (Body)',
    meaning:
      '시가와 종가 사이의 가격 범위. 종가가 시가보다 높으면 양봉, 낮으면 음봉입니다.',
    top: 0,
    bottom: 0,
    body: true,
  },
  {
    id: 'open',
    label: '시가 (Open) · 10,000원',
    meaning: '이 시간 구간에서 처음 거래가 체결된 가격.',
    top: 0,
    bottom: 0,
    body: true,
  },
  {
    id: 'lower',
    label: '아랫꼬리 (Lower Wick)',
    meaning: '저가에서 몸통의 아래쪽 끝까지의 가격 범위.',
    top: 0,
    bottom: 0,
    body: false,
  },
  {
    id: 'low',
    label: '저가 (Low) · 9,700원',
    meaning: '이 시간 구간에서 체결된 가격 중 가장 낮은 가격.',
    top: 0,
    bottom: '50%',
    body: false,
  },
] as const;

export function CandleAnatomy() {
  return (
    <View testID="candle-anatomy" style={s.card}>
      <Text accessibilityRole="header" style={s.heading}>
        한 캔들의 구조와 용어
      </Text>
      <Text style={s.helper}>
        양봉 예시 · 연결선으로 각 위치를 읽어보세요. 설명을 위해 세로 길이는
        가격에 비례하지 않습니다.
      </Text>
      <View>
        {anatomy.map((part) => (
          <View
            key={part.id}
            testID={`candle-term-${part.id}`}
            style={{ flexDirection: 'row', alignItems: 'stretch' }}
          >
            <View
              testID={`candle-anatomy-${part.id}`}
              style={{ width: 52 }}
              accessible={false}
            >
              <View
                style={{
                  position: 'absolute',
                  left: 15,
                  width: 3,
                  top: part.top,
                  bottom: part.bottom,
                  backgroundColor: UP_COLOR,
                }}
              />
              {part.body ? (
                <View
                  style={{
                    position: 'absolute',
                    left: 4,
                    width: 26,
                    top: part.id === 'close' ? '50%' : 0,
                    bottom: part.id === 'open' ? '50%' : 0,
                    backgroundColor: UP_COLOR,
                  }}
                />
              ) : null}
              <View
                style={{
                  position: 'absolute',
                  left: 16,
                  right: 0,
                  top: '50%',
                  borderTopWidth: 1,
                  borderColor: '#425966',
                }}
              />
            </View>
            <View
              style={{
                flex: 1,
                minWidth: 0,
                paddingVertical: 10,
                paddingLeft: 8,
              }}
            >
              <Text style={[s.body, s.bold]}>{part.label}</Text>
              <Text style={s.body}>{part.meaning}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
export function CandleFigure({
  candle,
  id,
  title,
  details = true,
}: {
  candle: Ohlc;
  id: string;
  title: string;
  details?: boolean;
}) {
  const parts = candleParts(candle);
  const color = candle.close >= candle.open ? UP_COLOR : DOWN_COLOR;
  const label = `${title}. ${parts.direction}. 시가 ${won(candle.open)}, 고가 ${won(candle.high)}, 저가 ${won(candle.low)}, 종가 ${won(candle.close)}.`;
  return (
    <View testID={id} style={s.card}>
      <Text accessibilityRole="header" style={s.heading}>
        {title}
      </Text>
      <View accessible accessibilityLabel={label}>
        <Svg width="100%" height={210} viewBox="0 0 200 210" accessible={false}>
          <Line
            x1={20}
            x2={180}
            y1={y(candle.open)}
            y2={y(candle.open)}
            stroke="#c5ced2"
            strokeDasharray="4 4"
          />
          <Line
            testID={`${id}-upper`}
            x1={100}
            x2={100}
            y1={y(candle.high)}
            y2={y(parts.body[1])}
            stroke={color}
            strokeWidth={3}
          />
          <Line
            testID={`${id}-lower`}
            x1={100}
            x2={100}
            y1={y(parts.body[0])}
            y2={y(candle.low)}
            stroke={color}
            strokeWidth={3}
          />
          <Rect
            testID={`${id}-body`}
            x={75}
            y={y(parts.body[1])}
            width={50}
            height={Math.max(1, y(parts.body[0]) - y(parts.body[1]))}
            fill={color}
          />
        </Svg>
      </View>
      <Text style={[s.body, s.bold]}>{parts.direction}</Text>
      <Text style={s.body}>
        시가 {won(candle.open)}
        {'\n'}고가 {won(candle.high)}
        {'\n'}저가 {won(candle.low)}
        {'\n'}종가 {won(candle.close)}
      </Text>
      {details ? (
        <>
          <Text style={s.helper}>몸통: {parts.body.map(won).join(' ~ ')}</Text>
          <Text style={s.helper}>
            윗꼬리: {parts.upper.map(won).join(' ~ ')}
          </Text>
          <Text style={s.helper}>
            아랫꼬리: {parts.lower.map(won).join(' ~ ')}
          </Text>
        </>
      ) : null}
    </View>
  );
}
export function PricePath({ prices, id }: { prices: number[]; id: string }) {
  const points = prices
    .map((price, i) => `${20 + i * 80},${y(price)}`)
    .join(' ');
  return (
    <View style={s.section} testID={id}>
      <Svg width="100%" height={160} viewBox="0 0 280 210" accessible={false}>
        <Polyline
          testID={`${id}-line`}
          points={points}
          fill="none"
          stroke="#245b76"
          strokeWidth={3}
        />
      </Svg>
      <Text style={s.body} accessibilityLiveRegion="polite">
        가격 경로: {prices.map(won).join(' → ')}
      </Text>
    </View>
  );
}
