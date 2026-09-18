import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { CandleFigure, PricePath } from './CandleFigures';
import {
  Body,
  Comparison,
  LessonAction,
  LessonPage,
  Result,
  Section,
  Takeaways,
  lessonStyles as s,
} from './LessonUi';
import {
  FIVE_MINUTE,
  PATH_A,
  PATH_B,
  aggregateCandles,
  ohlcFromPrices,
  won,
  type Ohlc,
} from './lessonCalculations';
import { useLessonSequence } from './useLessonSequence';

const pathFrames = (path: number[]) => [
  { value: path.slice(0, 1) },
  ...path.map((_, i) => ({
    value: path.slice(0, i + 1),
    delay: i === path.length - 1 ? undefined : 1000,
  })),
];
const framesA = pathFrames(PATH_A);
const framesB = pathFrames(PATH_B);
const controls: { field: 'high' | 'low' | 'close'; label: string; values: number[] }[] = [
  { field: 'high', label: '고가', values: [10400, 10600, 10800] },
  { field: 'low', label: '저가', values: [9500, 9700] },
  { field: 'close', label: '종가', values: [9800, 10000, 10400] },
];
const takeaways = [
  '캔들은 일정 시간의 시가·고가·저가·종가(OHLC)를 요약합니다.',
  '몸통은 시가와 종가 사이를 나타냅니다.',
  '꼬리는 해당 시간의 고가와 저가 범위를 보여줍니다.',
  '한 개의 OHLC 캔들만으로 시간 내부의 정확한 가격 이동 순서를 알 수 없습니다.',
  '시간봉이 달라지면 같은 가격 움직임도 다른 형태로 집계됩니다.',
];
function CandlesLesson() {
  const [candle, setCandle] = useState<Ohlc>({ open: 10000, high: 10600, low: 9700, close: 10400 });
  const [built, setBuilt] = useState(false);
  const a = useLessonSequence(framesA);
  const b = useLessonSequence(framesB);
  const [aggregated, setAggregated] = useState(false);
  const combined = aggregateCandles(FIVE_MINUTE);
  return (
    <>
      <Section title="캔들은 무엇을 보여줄까요?" introduction>
        <Body>
          캔들(Candlestick)은 일정 시간 동안 형성된 시가(Open), 고가(High), 저가(Low), 종가(Close)를
          하나의 도형으로 압축해 보여줍니다.
        </Body>
      </Section>
      <Section title="실습 1 · 가격으로 캔들 만들기" id="candle-builder">
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
                  disabled={built}
                  onPress={() => setCandle((previous) => ({ ...previous, [control.field]: value }))}
                />
              ))}
            </View>
          </View>
        ))}
        <CandleFigure candle={candle} id="candle-builder-figure" title="선택한 가격의 캔들" />
        <Body>
          종가가 시가보다 높으면 양봉, 낮으면 음봉입니다. 몸통은 시가와 종가 사이이며, 윗꼬리는 몸통
          위부터 고가까지, 아랫꼬리는 저가부터 몸통 아래까지의 가격 범위입니다.
        </Body>
        <LessonAction
          id="candle-builder-confirm"
          label="선택한 캔들 결과 확인"
          disabled={built}
          onPress={() => setBuilt(true)}
        />
        {built ? (
          <Result title="실습 1 · 결과 해석" id="candle-builder-result">
            <Body>
              시가는 구간의 첫 체결가격, 종가는 마지막 체결가격입니다. 고가와 저가는 구간에서 체결된
              가격의 최댓값과 최솟값입니다.
            </Body>
            <Body>
              몸통(Body)은 시가와 종가 사이를 나타냅니다. 윗꼬리(Upper Wick)와 아랫꼬리(Lower
              Wick)는 몸통 바깥에서 관찰된 고가·저가 범위를 나타냅니다. 해당 범위가 없으면 그 꼬리도
              없습니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {built ? (
        <Section title="실습 2 · 같은 캔들, 다른 가격 경로" id="candle-paths">
          <Body>
            먼저 고가를 형성한 경로 A와 먼저 저가를 형성한 경로 B를 차례로 재생합니다. 각 순간까지의
            가격으로 캔들이 만들어집니다.
          </Body>
          <LessonAction
            id="candle-path-a-run"
            label="경로 A 재생"
            disabled={a.started}
            onPress={a.start}
          />
          <PricePath id="candle-path-a" prices={a.value} />
          <CandleFigure
            id="candle-path-a-figure"
            title="경로 A의 캔들"
            candle={ohlcFromPrices(a.value)}
          />
          {a.complete ? (
            <>
              <Result title="경로 A · 결과" id="candle-path-a-result">
                <Body>
                  시가에서 고가, 저가, 종가 순서로 움직였습니다. 이어서 가격의 이동 순서를 바꾸어
                  비교합니다.
                </Body>
              </Result>
              <LessonAction
                id="candle-path-b-run"
                label="경로 B 재생"
                disabled={b.started}
                onPress={b.start}
              />
              <PricePath id="candle-path-b" prices={b.value} />
              <CandleFigure
                id="candle-path-b-figure"
                title="경로 B의 캔들"
                candle={ohlcFromPrices(b.value)}
              />
            </>
          ) : null}
          {b.complete ? (
            <Result title="실습 2 · 동일한 OHLC" id="candle-paths-result">
              <Comparison>
                <CandleFigure
                  id="candle-compare-a"
                  title="경로 A · 최종"
                  candle={ohlcFromPrices(a.value)}
                  details={false}
                />
                <CandleFigure
                  id="candle-compare-b"
                  title="경로 B · 최종"
                  candle={ohlcFromPrices(b.value)}
                  details={false}
                />
              </Comparison>
              <Body>
                서로 다른 경로가 같은 OHLC 캔들을 만듭니다. 일반적인 OHLC 캔들은 해당 시간 동안의
                시가·고가·저가·종가를 보여주지만, 고가와 저가가 어떤 순서로 형성되었는지는 알려주지
                않습니다.
              </Body>
              <Body>
                캔들은 관찰된 가격 정보이며 참가자의 의도를 직접 보여주는 데이터가 아닙니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {b.complete ? (
        <Section title="실습 3 · 시간봉과 집계" id="candle-aggregation">
          <Body>
            연속된 세 개의 5분 캔들을 같은 가격 축에서 확인한 뒤, 하나의 15분 캔들로 집계합니다.
          </Body>
          <Comparison>
            {FIVE_MINUTE.map((item, i) => (
              <CandleFigure
                key={i}
                id={`candle-five-${i}`}
                title={`${i + 1}번째 5분`}
                candle={item}
                details={false}
              />
            ))}
          </Comparison>
          <LessonAction
            id="candle-aggregate-run"
            label="5분 → 15분으로 집계"
            onPress={() => setAggregated(true)}
            disabled={aggregated}
          />
          {aggregated ? (
            <>
              <Result title="실습 3 · 15분 집계 결과" id="candle-aggregate-result">
                <CandleFigure id="candle-fifteen" title="15분 캔들" candle={combined} />
                <Body>시가: 첫 5분 캔들의 시가 → {won(combined.open)}</Body>
                <Body>
                  고가: {FIVE_MINUTE.findIndex((item) => item.high === combined.high) + 1}번째 5분의
                  고가가 전체 최댓값 → {won(combined.high)}
                </Body>
                <Body>
                  저가: {FIVE_MINUTE.findIndex((item) => item.low === combined.low) + 1}번째 5분의
                  저가가 전체 최솟값 → {won(combined.low)}
                </Body>
                <Body>종가: 마지막 5분 캔들의 종가 → {won(combined.close)}</Body>
                <Body>
                  시간봉은 가격 데이터를 바라보는 집계 단위입니다. 같은 시장 움직임도 선택한 시간
                  단위에 따라 다른 형태의 캔들로 보일 수 있습니다.
                </Body>
              </Result>
              <Takeaways items={takeaways} />
            </>
          ) : null}
        </Section>
      ) : null}
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
        label="처음부터 다시 보기"
        secondary
        onPress={() => setVersion((v) => v + 1)}
      />
    </LessonPage>
  );
}
