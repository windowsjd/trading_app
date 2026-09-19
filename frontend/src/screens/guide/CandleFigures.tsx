import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Line, Polyline, Rect } from 'react-native-svg';
import { candleParts, won, type Ohlc } from './lessonCalculations';
import { lessonStyles as s } from './LessonUi';
import { UP_COLOR, DOWN_COLOR } from '../../components/charts/candleColors';

// All teaching candles share a price scale so their shapes are comparable.
const y = (price: number) => 190 - ((price - 9400) / 1600) * 170;
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
          <Text style={s.helper}>윗꼬리: {parts.upper.map(won).join(' ~ ')}</Text>
          <Text style={s.helper}>아랫꼬리: {parts.lower.map(won).join(' ~ ')}</Text>
        </>
      ) : null}
    </View>
  );
}
export function PricePath({ prices, id }: { prices: number[]; id: string }) {
  const points = prices.map((price, i) => `${20 + i * 80},${y(price)}`).join(' ');
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
