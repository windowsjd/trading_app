import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  Body,
  Comparison,
  LessonAction,
  LessonPage,
  Result,
  Section,
  SimulationBook,
  Takeaways,
  TradeValues,
  lessonStyles as s,
} from './LessonUi';
import {
  CANCEL_ASKS,
  SIZE_ASKS,
  THICK_ASKS,
  THIN_ASKS,
  buyFrames,
  emptyBook,
  type TimedFrame,
  type BookFrame,
} from './lessonCalculations';
import { useLessonSequence } from './useLessonSequence';

const thick = buyFrames(THICK_ASKS, 20);
const thin = buyFrames(THIN_ASKS, 20);
const comparison = thin.map((frame, i) => ({
  value: { a: thick[Math.min(i, thick.length - 1)].value, b: frame.value },
  delay: frame.delay,
}));
const cancelled: BookFrame = {
  ...emptyBook(CANCEL_ASKS.slice(0, 1)),
  status: '10,010원의 매도 주문이 취소되었습니다. 체결은 없으며 현재가는 10,000원입니다.',
};
const cancellation: TimedFrame<BookFrame>[] = [
  { value: emptyBook(CANCEL_ASKS) },
  { value: cancelled },
];
const afterCancellation = buyFrames(cancelled.asks, 1);
const sizes = [3, 10, 20, 30];
const takeaways = [
  '유동성이 높을수록 일정 규모의 주문을 좁은 가격 범위에서 체결하기 쉽습니다.',
  '같은 주문도 호가의 잔량에 따라 평균 체결가격과 가격 영향이 달라질 수 있습니다.',
  '호가의 추가·취소는 대기 주문의 변화이며 실제 체결과는 다릅니다.',
  '최근 체결가격 기준의 현재가는 실제 체결이 발생해야 변경됩니다.',
  '주문 규모가 대기 물량에 비해 커질수록 여러 가격대를 체결하며 가격 충격이 커질 수 있습니다.',
];

function SizeTrial({
  quantity,
  index,
  onDone,
  onStart,
}: {
  quantity: number;
  index: number;
  onDone: () => void;
  onStart?: () => void;
}) {
  const frames = useMemo(() => buyFrames(SIZE_ASKS, quantity), [quantity]);
  const lesson = useLessonSequence(frames);
  React.useEffect(() => {
    if (lesson.complete) onDone();
  }, [lesson.complete, onDone]);
  const id = `liquidity-size-${index}`;
  return (
    <Section title={`${quantity}주 매수 · 동일한 초기 호가에서 비교`} id={id}>
      <Body>
        현재가 10,000원에서 시작합니다. 이 주문이 어느 매도호가까지 체결될지 잔량을 확인해보세요.
      </Body>
      <LessonAction
        id={`${id}-run`}
        label={`${quantity}주 매수 실행`}
        disabled={lesson.started}
        onPress={() => {
          lesson.start();
          onStart?.();
        }}
      />
      <SimulationBook id={`${id}-book`} frame={lesson.value} />
      {lesson.started ? (
        <Result
          title={lesson.complete ? `${quantity}주 매수 결과` : '체결 진행'}
          id={`${id}-result`}
        >
          <TradeValues id={`${id}-values`} frame={lesson.value} initialAsks={SIZE_ASKS} />
          {lesson.complete ? (
            <Body>
              주문의 절대적인 크기보다 현재 시장의 대기 물량에 비해 주문이 얼마나 큰지가 가격 영향에
              중요합니다. 더 높은 매도호가까지 체결하면 평균 체결가와 마지막 체결가격이 높아질 수
              있습니다.
            </Body>
          ) : null}
        </Result>
      ) : null}
    </Section>
  );
}

function LiquidityLesson() {
  const compare = useLessonSequence(comparison);
  const cancel = useLessonSequence(cancellation);
  const trade = useLessonSequence(afterCancellation);
  const [firstStarted, setFirstStarted] = useState(false);
  const [trials, setTrials] = useState<number[]>([3]);
  const [completedCount, setCompletedCount] = useState(0);
  const markTrialDone = React.useCallback(() => setCompletedCount(trials.length), [trials.length]);
  return (
    <>
      <Section title="유동성은 가격에 어떤 영향을 줄까요?" introduction>
        <Body>
          유동성(Liquidity)은 일정 규모의 주문을 가격에 큰 영향을 주지 않고 체결할 수 있는 정도를
          의미합니다. 호가창에 대기 중인 물량이 충분할수록 같은 주문도 더 좁은 가격 범위에서 체결될
          가능성이 높습니다.
        </Body>
      </Section>
      <Section title="실습 1 · 같은 주문, 다른 유동성" id="liquidity-compare">
        <Body>
          두 시장에 같은 20주 매수 요청을 보내고, 대기 물량에 따라 체결가격이 어떻게 달라지는지
          비교합니다.
        </Body>
        <LessonAction
          id="liquidity-compare-run"
          label="두 시장에서 20주 매수 실행"
          disabled={compare.started}
          onPress={compare.start}
        />
        <Comparison>
          <SimulationBook
            title="시장 A · 두꺼운 호가"
            id="liquidity-thick"
            frame={compare.value.a}
            follow={false}
          />
          <SimulationBook title="시장 B · 얇은 호가" id="liquidity-thin" frame={compare.value.b} />
        </Comparison>
        {compare.complete ? (
          <Result title="실습 1 · 체결 결과" id="liquidity-compare-result">
            <Comparison>
              <Section title="시장 A">
                <TradeValues
                  id="liquidity-thick-values"
                  frame={compare.value.a}
                  initialAsks={THICK_ASKS}
                />
              </Section>
              <Section title="시장 B">
                <TradeValues
                  id="liquidity-thin-values"
                  frame={compare.value.b}
                  initialAsks={THIN_ASKS}
                />
              </Section>
            </Comparison>
            <Body>
              같은 20주 주문도 대기 물량에 따라 평균 체결가격과 마지막 체결가격이 달라집니다. 시장
              A에서는 한 가격의 잔량으로 충분하지만, 시장 B에서는 세 가격대의 매도호가와 체결됩니다.
            </Body>
            <Body>
              유동성이 충분하면 같은 주문을 더 좁은 가격 범위에서 체결하기 쉽습니다. 주문 자체가
              대기 중인 호가를 소진하면서 체결가격을 여러 가격대로 이동시키는 효과를 가격 충격(Price
              Impact)이라고 합니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {compare.complete ? (
        <Section title="실습 2 · 호가 변화와 체결은 다르다" id="liquidity-cancel">
          <Body>10,010원의 매도 주문 3주를 취소하면 현재가도 바뀔까요?</Body>
          <LessonAction
            id="liquidity-cancel-run"
            label="10,010원의 매도 주문 취소"
            onPress={cancel.start}
            disabled={cancel.started}
          />
          <SimulationBook id="liquidity-cancel-book" frame={cancel.value} />
          {cancel.complete ? (
            <>
              <Result title="주문 취소 결과" id="liquidity-cancel-result">
                <Body>
                  가장 가까운 매도호가는 10,020원이 되었지만 현재가는 10,000원입니다. 호가창의 대기
                  주문이 추가되거나 취소되더라도 실제 거래가 체결되지 않았다면 최근 체결가격을
                  기준으로 하는 현재가는 변하지 않습니다.
                </Body>
              </Result>
              <Section title="이어서 · 실제 체결 발생">
                <Body>취소 이후 남은 매도호가인 10,020원에서 1주를 실제로 체결해봅니다.</Body>
                <LessonAction
                  id="liquidity-trade-run"
                  label="10,020원에서 1주 매수 실행"
                  onPress={trade.start}
                  disabled={trade.started}
                />
                <SimulationBook id="liquidity-trade-book" frame={trade.value} />
                {trade.complete ? (
                  <Result title="실제 체결 결과" id="liquidity-trade-result">
                    <TradeValues
                      id="liquidity-trade-values"
                      frame={trade.value}
                      initialAsks={cancelled.asks}
                    />
                    <Body>
                      10,020원에서 거래가 성사된 뒤에야 현재가가 10,000원에서 10,020원으로
                      변경됩니다. 대기 주문의 변화와 체결가격의 변화는 구분해야 합니다.
                    </Body>
                  </Result>
                ) : null}
              </Section>
            </>
          ) : null}
        </Section>
      ) : null}
      {trade.complete ? (
        <Section title="실습 3 · 주문 규모와 가격 충격" id="liquidity-size">
          <Body>
            동일한 초기 호가에서 주문수량을 선택합니다. 주문이 대기 물량에 비해 커질수록 더 많은
            가격대의 잔량을 소진할 수 있습니다.
          </Body>
          <View style={s.choices}>
            {sizes.map((size) => (
              <LessonAction
                key={size}
                id={`liquidity-select-${size}`}
                label={`${size}주`}
                secondary={trials[0] !== size}
                selected={trials[0] === size}
                disabled={firstStarted}
                onPress={() => setTrials([size])}
              />
            ))}
          </View>
          {trials.map((quantity, i) => (
            <SizeTrial
              key={i}
              quantity={quantity}
              index={i}
              onStart={i === 0 ? () => setFirstStarted(true) : undefined}
              onDone={i === trials.length - 1 ? markTrialDone : ignoreDone}
            />
          ))}
          {trials.length > 0 && completedCount === trials.length ? (
            <>
              {sizes.some((size) => !trials.includes(size)) ? (
                <Section title="다른 수량과 비교">
                  <Body>
                    아래에서 동일한 초기 호가로 다시 비교할 수 있습니다. 앞선 결과는 그대로
                    남습니다.
                  </Body>
                  <View style={s.choices}>
                    {sizes
                      .filter((size) => !trials.includes(size))
                      .map((size) => (
                        <LessonAction
                          key={size}
                          id={`liquidity-compare-${size}`}
                          label={`${size}주와 비교`}
                          secondary
                          onPress={() => setTrials([...trials, size])}
                        />
                      ))}
                  </View>
                </Section>
              ) : null}
              <Takeaways items={takeaways} />
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
function ignoreDone() {
  /* Completed trials retain their own result. */
}
export default function LiquidityScreen() {
  const [version, setVersion] = useState(0);
  return (
    <LessonPage key={version} id="guide-liquidity-screen">
      <LiquidityLesson />
      <LessonAction
        id="liquidity-reset"
        label="처음부터 다시 보기"
        secondary
        onPress={() => setVersion((v) => v + 1)}
      />
    </LessonPage>
  );
}
