import React, { useState } from 'react';
import { Text, View } from '../../theme/native';
import { CandleAnatomy, CandleFigure } from './CandleFigures';
import { Body, LessonAction, LessonPage, Section, Takeaways, lessonStyles as s } from './LessonUi';
import { won, type Ohlc } from './lessonCalculations';

const controls: { field: 'high' | 'low' | 'close'; label: string; values: number[] }[] = [
  { field: 'high', label: '고가', values: [10400, 10600, 10800] },
  { field: 'low', label: '저가', values: [9500, 9700] },
  { field: 'close', label: '종가', values: [9800, 10000, 10400] },
];
const takeaways = [
  '캔들은 일정 시간의 시가·고가·저가·종가(OHLC)를 요약합니다.',
  '몸통은 시가와 종가 사이를 나타냅니다.',
  '꼬리는 해당 시간의 고가와 저가 범위를 보여줍니다.',
];
function CandlesLesson() {
  const [candle, setCandle] = useState<Ohlc>({ open: 10000, high: 10600, low: 9700, close: 10400 });
  return (
    <>
      <Section title="캔들은 무엇을 보여줄까요?" introduction>
        <Body>
          캔들(Candlestick)은 일정 시간 동안 형성된 시가(Open), 고가(High), 저가(Low), 종가(Close)를
          하나의 도형으로 압축해 보여줍니다.
        </Body>
      </Section>
      <CandleAnatomy />
      <Section title="실습 · 가격으로 캔들 만들기" id="candle-builder">
        <Body>
          시가는 10,000원으로 고정합니다. 고가·저가·종가를 바꾸고 몸통과 꼬리의 변화를 확인하세요.
          종가를 시가보다 낮게 선택하면 음봉도 만들 수 있습니다.
        </Body>
        {controls.map((control) => (
          <View key={control.field} style={s.section}>
            <Text style={[s.body, s.bold]}>{control.label} 선택</Text>
            <View style={s.choices}>
              {control.values.map((value) => (
                <LessonAction
                  key={value}
                  id={`candle-${control.field}-${value}`}
                  label={won(value)}
                  selected={candle[control.field] === value}
                  secondary={candle[control.field] !== value}
                  tone="black"
                  onPress={() => setCandle((previous) => ({ ...previous, [control.field]: value }))}
                />
              ))}
            </View>
          </View>
        ))}
        <CandleFigure candle={candle} id="candle-builder-figure" title="선택한 가격의 캔들" />
        <Body>선택한 가격이 그림의 몸통과 꼬리에 어떻게 연결되는지 확인해보세요.</Body>
      </Section>
      <Takeaways items={takeaways} />
    </>
  );
}
export default function CandlesScreen() {
  const [version, setVersion] = useState(0);
  return (
    <LessonPage key={version} id="guide-candles-screen">
      <CandlesLesson />
      <LessonAction
        id="candles-reset"
        label="처음부터"
        secondary
        onPress={() => setVersion((v) => v + 1)}
      />
    </LessonPage>
  );
}
