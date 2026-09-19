import React, { useState } from 'react';
import { View } from 'react-native';
import {
  Body,
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
  THIN_ASKS,
  buyFrames,
  emptyBook,
  type BookFrame,
  type TimedFrame,
} from './lessonCalculations';
import { useLessonSequence } from './useLessonSequence';

const marketFrames = buyFrames(THIN_ASKS, 12);
const limitInitial = emptyBook(THIN_ASKS, [{ price: 9980, quantity: 7 }]);
const waiting: BookFrame = {
  ...limitInitial,
  bids: [{ price: 9990, quantity: 10 }, ...limitInitial.bids],
  status:
    '내 지정가 주문: 9,990원 · 10주 · 대기 중. 현재 매도호가와 가격 조건이 맞지 않아 체결되지 않았습니다.',
};
const changed: BookFrame = {
  ...waiting,
  asks: [{ price: 10040, quantity: 6 }, ...THIN_ASKS.filter((row) => row.price !== 10010)],
  status:
    '10,010원 매도 주문 취소, 10,040원 매도 주문 추가. 실제 체결은 없으며 내 지정가 주문은 대기 중입니다.',
};
const limitFrames: TimedFrame<BookFrame>[] = [
  { value: changed },
  {
    value: {
      ...changed,
      targetPrice: 9990,
      targetSide: '매수',
      status: '9,990원에 매도 가능한 10주가 도달했습니다. 대기 중인 내 매수 주문과 체결합니다.',
    },
    delay: 1000,
  },
  {
    value: {
      ...changed,
      bids: [{ price: 9990, quantity: 0 }, ...limitInitial.bids],
      targetPrice: 9990,
      targetSide: '매수',
      filledQuantity: 10,
      lastPrice: 9990,
      fills: [{ price: 9990, quantity: 10 }],
      status: '9,990원에서 10주 체결. 내 지정가 주문: 체결. 현재가 9,990원.',
    },
    delay: 1200,
  },
  {
    value: {
      ...changed,
      bids: limitInitial.bids,
      lastPrice: 9990,
      fills: [{ price: 9990, quantity: 10 }],
      status: '내 지정가 주문: 10주 전량 체결. 현재가 9,990원.',
    },
  },
];
const takeaways = [
  '시장가 주문은 체결 가능성을 우선합니다.',
  '시장가 주문의 실제 평균 체결가격은 호가 상황에 따라 달라질 수 있습니다.',
  '지정가 주문은 가격 조건을 우선합니다.',
  '지정가 주문은 조건이 충족되지 않으면 체결되지 않을 수 있습니다.',
  '주문방식은 즉시 체결과 가격 통제 사이의 선택과 관련됩니다.',
];
type Choice = '시장가' | '지정가';
function OrderChoice({
  id,
  choice,
  onChoose,
}: {
  id: string;
  choice: Choice | null;
  onChoose: (choice: Choice) => void;
}) {
  return (
    <View style={s.choices}>
      {(['시장가', '지정가'] as const).map((value) => (
        <LessonAction
          key={value}
          id={`${id}-${value === '시장가' ? 'market' : 'limit'}`}
          label={`${value} 선택`}
          selected={choice === value}
          secondary={choice !== value}
          disabled={choice !== null}
          onPress={() => onChoose(value)}
        />
      ))}
    </View>
  );
}
function OrderTypesLesson() {
  const market = useLessonSequence(marketFrames);
  const [registered, setRegistered] = useState(false);
  const [quoteChanged, setQuoteChanged] = useState(false);
  const limit = useLessonSequence(limitFrames);
  const [choiceA, setChoiceA] = useState<Choice | null>(null);
  const [choiceB, setChoiceB] = useState<Choice | null>(null);
  return (
    <>
      <Section title="주문에서 무엇을 선택할까요?" introduction>
        <Body>주문 방식의 핵심 차이는 체결을 우선할지, 원하는 가격을 우선할지에 있습니다.</Body>
        <Body>
          시장가 주문은 현재 시장에서 가능한 가격으로 즉시 체결을 시도하는 주문입니다. 체결 가능성을
          우선하지만 실제 체결가격은 호가 상황에 따라 달라질 수 있습니다.
        </Body>
        <Body>
          지정가 주문은 사용자가 지정한 가격 또는 그보다 유리한 가격에서만 체결되도록 조건을 두는
          주문입니다. 가격 조건을 우선하지만 주문이 체결되지 않을 수 있습니다.
        </Body>
      </Section>
      <Section title="실습 1 · 시장가 주문" id="orders-market">
        <Body>
          화면의 현재가는 10,000원입니다. 12주를 매수하면 어떤 가격에서 거래가 성사되는지
          확인하세요.
        </Body>
        <LessonAction
          id="orders-market-run"
          label="12주 시장가 매수 실행"
          onPress={market.start}
          disabled={market.started}
        />
        <SimulationBook id="orders-market-book" frame={market.value} />
        {market.started ? (
          <Result
            title={market.complete ? '실습 1 · 체결 결과' : '시장가 체결 진행'}
            id="orders-market-result"
          >
            <TradeValues id="orders-market-values" frame={market.value} initialAsks={THIN_ASKS} />
            {market.complete ? (
              <>
                <Body>
                  10,010원에서 5주가 체결되고 남은 7주는 10,020원에서 체결되었습니다. 화면에 보였던
                  현재가 10,000원과 실제 평균 체결가격은 다릅니다.
                </Body>
                <Body>
                  시장가 주문은 대기 중인 호가와 체결되므로 실행 시점의 잔량에 따라 체결가격이
                  달라집니다. 체결을 우선하지만 대기 물량이 부족하면 전량 체결되지 않을 수도
                  있습니다.
                </Body>
              </>
            ) : null}
          </Result>
        ) : null}
      </Section>
      {market.complete ? (
        <Section title="실습 2 · 지정가 주문" id="orders-limit">
          <Body>
            현재가 10,000원, 매도호가 10,010원 이상인 초기 시장 상황으로 비교합니다. 9,990원
            이하에서만 10주를 매수하도록 가격 조건을 둡니다.
          </Body>
          <LessonAction
            id="orders-limit-register"
            label="9,990원에 10주 지정가 매수 등록"
            disabled={registered}
            onPress={() => setRegistered(true)}
          />
          <SimulationBook
            id="orders-limit-book"
            frame={registered ? waiting : limitInitial}
            ownBid={9990}
          />
          {registered ? (
            <>
              <Result title="지정가 등록 결과 · 대기 중" id="orders-limit-waiting">
                <Body>
                  매도호가는 지정한 매수가격보다 높습니다. 즉시 체결되지 않고 매수 쪽에 9,990원 ·
                  10주가 대기합니다. 주문 등록만으로 현재가가 바뀌지는 않습니다.
                </Body>
              </Result>
              <Section title="상황 A · 호가만 변함" id="orders-quotes">
                <Body>
                  다른 매도 주문이 추가·취소되어도 내 주문이 자동으로 체결되는 것은 아닙니다.
                </Body>
                <LessonAction
                  id="orders-quotes-run"
                  label="다른 매도 주문 추가·취소"
                  disabled={quoteChanged}
                  onPress={() => setQuoteChanged(true)}
                />
                <SimulationBook
                  id="orders-quotes-book"
                  frame={quoteChanged ? changed : waiting}
                  ownBid={9990}
                />
                {quoteChanged ? (
                  <Result title="호가 변화 결과 · 계속 대기" id="orders-quotes-result">
                    <Body>
                      매도호가가 바뀌었지만 9,990원에서는 거래가 성사되지 않았습니다. 내 10주 주문은
                      계속 대기하며 현재가도 10,000원입니다.
                    </Body>
                  </Result>
                ) : null}
              </Section>
              {quoteChanged ? (
                <Section title="상황 B · 조건에 맞는 매도 흐름 도달" id="orders-limit-execution">
                  <Body>
                    이번에는 9,990원에 매도할 수 있는 10주가 도달해 내 매수 주문과 실제로
                    체결됩니다.
                  </Body>
                  <LessonAction
                    id="orders-limit-run"
                    label="9,990원에서 체결 가능한 매도 흐름 발생"
                    disabled={limit.started}
                    onPress={limit.start}
                  />
                  <SimulationBook id="orders-limit-active-book" frame={limit.value} ownBid={9990} />
                  {limit.complete ? (
                    <Result title="실습 2 · 지정가 체결 결과" id="orders-limit-result">
                      <TradeValues id="orders-limit-values" frame={limit.value} />
                      <Body>
                        내 주문이 대기 중에서 체결 상태로 바뀌었습니다. 지정가 주문은 원하는 가격
                        조건을 통제할 수 있지만 실제 거래가 그 가격에 도달하고 체결 조건이 충족되지
                        않으면 계속 대기하거나 미체결 상태로 남을 수 있습니다.
                      </Body>
                      <Body>
                        이 예에서는 지정가격인 9,990원에 체결되었습니다. 지정가 매수는 지정가격
                        이하, 지정가 매도는 지정가격 이상에서 체결될 수 있습니다.
                      </Body>
                    </Result>
                  ) : null}
                </Section>
              ) : null}
            </>
          ) : null}
        </Section>
      ) : null}
      {limit.complete ? (
        <Section title="실습 3 · 목적에 맞는 주문 선택" id="orders-choice">
          <Section title="상황 A · 신속한 매도 우선">
            <Body>
              보유한 6주를 현재가 부근에서 즉시 정리하는 것이 작은 가격 차이보다 더 중요합니다. 현재
              매수호가의 잔량을 보고 주문방식을 선택하세요.
            </Body>
            <SimulationBook id="orders-choice-a-book" frame={emptyBook(THIN_ASKS)} />
            <OrderChoice id="orders-choice-a" choice={choiceA} onChoose={setChoiceA} />
            {choiceA ? (
              <Result title={`상황 A · ${choiceA} 선택 해설`} id="orders-choice-a-result">
                <Body>
                  {choiceA === '시장가'
                    ? '체결을 우선하는 목적에 부합할 수 있습니다.'
                    : '지정가는 가격을 통제할 수 있지만, 가격 조건에 따라 매도가 지연될 수 있습니다.'}{' '}
                  현재 매수호가 9,990원의 잔량은 4주이므로, 6주를 즉시 매도하려면 다음 매수호가도
                  사용하게 됩니다. 시장가 주문도 실제 체결가격은 호가 상황에 따라 달라질 수
                  있습니다.
                </Body>
              </Result>
            ) : null}
          </Section>
          {choiceA ? (
            <Section title="상황 B · 매수 가격 상한 우선">
              <Body>
                10,000원 이하에서만 매수할 계획이며 체결되지 않아도 괜찮습니다. 현재 매도호가는
                10,010원부터 대기 중입니다.
              </Body>
              <SimulationBook id="orders-choice-b-book" frame={emptyBook(THIN_ASKS)} />
              <OrderChoice id="orders-choice-b" choice={choiceB} onChoose={setChoiceB} />
              {choiceB ? (
                <Result title={`상황 B · ${choiceB} 선택 해설`} id="orders-choice-b-result">
                  <Body>
                    {choiceB === '지정가'
                      ? '가격 조건을 우선하므로 지정가가 목적에 부합합니다.'
                      : '시장가는 현재 대기 중인 매도호가와 체결하므로 10,000원이라는 상한을 보장하지 않습니다.'}{' '}
                    10,000원의 지정가 매수는 그 가격 이하에서만 체결되며, 현재 호가에서는 대기할 수
                    있습니다. 주문방식의 우열보다 체결과 가격 통제 중 무엇을 우선하는지가
                    중요합니다.
                  </Body>
                </Result>
              ) : null}
            </Section>
          ) : null}
          {choiceB ? <Takeaways items={takeaways} /> : null}
        </Section>
      ) : null}
    </>
  );
}
export default function OrderTypesScreen() {
  const [version, setVersion] = useState(0);
  return (
    <LessonPage key={version} id="guide-order-types-screen">
      <OrderTypesLesson />
      <LessonAction
        id="orders-reset"
        label="처음부터"
        secondary
        onPress={() => setVersion((v) => v + 1)}
      />
    </LessonPage>
  );
}
