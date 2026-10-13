import React, { useState } from 'react';
import { Text, View } from '../../theme/native';
import {
  Body,
  LessonAction,
  Result,
  Section,
  Takeaways,
  lessonStyles as s,
} from './LessonUi';
import { Basis, CandleSeries, Choices, Values } from './MarketLessonUi';
import { auctionBuys, auctionSells } from './marketLessonData';
import {
  changeRate,
  openingBuyOrder,
  percent,
  priceDomain,
} from './marketLessonCalculations';
import { won, ohlcFromPrices } from './lessonCalculations';

export function ClosedMarketLesson() {
  const [night, setNight] = useState(false);
  const [price, setPrice] = useState<10100 | 10300 | null>(null);
  const [placed, setPlaced] = useState(false);
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(0);
  const [opened, setOpened] = useState(false);
  const [finished, setFinished] = useState(false);
  const [more, setMore] = useState(false);
  const buys = auctionBuys.slice(0, stage);
  const sells = auctionSells.slice(0, stage);
  const opening =
    price === null ? null : openingBuyOrder(price, 10, auctionBuys, auctionSells);
  const auction = opening?.auction;
  const result = auction?.result;
  return (
    <>
      <Basis>KRX 일반주식 기준 · 가격과 주문은 가상 예제</Basis>
      <Section id="closed-market-1" title="1. 장 마감">
        <Body>
          오후 3시 30분에 정규장이 끝났습니다. 오늘의 마지막 가격, 종가는 10,000원입니다.
        </Body>
        <Values
          id="closed-market-close"
          rows={[
            ['종가', '10,000원'],
            ['장 마감 후 체결', '0건'],
          ]}
        />
        <Body>
          장이 닫혀 있어도 지정가 주문은 미리 낼 수 있습니다. 다만 장이 열릴 때까지 체결되지 않습니다.
        </Body>
        <LessonAction
          id="closed-market-next"
          label="다음 · 밤사이 주문 내기"
          disabled={night}
          onPress={() => setNight(true)}
        />
      </Section>
      {night ? (
        <Section id="closed-market-2" title="2. 밤사이: 주문이 쌓입니다">
          <Body>
            밤사이 '실적이 예상보다 좋다'는 가상 뉴스가 나왔습니다. 내일 이 주식을 사고 싶다면 가격을 정해 10주를 주문해 보세요.
          </Body>
          <Body>지정가 매수는 '이 가격 이하로만 사겠다'는 주문입니다.</Body>
          <Choices<10100 | 10300>
            id="closed-market-price"
            options={[
              { value: 10100, label: '10,100원에 매수' },
              { value: 10300, label: '10,300원에 매수' },
            ]}
            value={price}
            disabled={placed}
            onChange={setPrice}
          />
          <LessonAction
            id="closed-market-order"
            label="지정가 매수 10주 주문 내기"
            disabled={price === null || placed}
            onPress={() => setPlaced(true)}
          />
          {placed ? (
            <>
              <Result id="closed-market-order-result" title="주문 접수">
                <Body>
                  {`${won(price)}에 10주 매수 주문이 접수되었습니다. 아직 체결되지 않았습니다.`}
                </Body>
              </Result>
              <Body>
                시간을 보내면 다른 사람들의 주문도 쌓입니다. 현재가가 어떻게 되는지 보세요.
              </Body>
              <LessonAction
                id="closed-market-time"
                label={`시간 보내기 (${stage}/3)`}
                disabled={stage === 3}
                onPress={() =>
                  setStage((value) => Math.min(3, value + 1) as 0 | 1 | 2 | 3)
                }
              />
              <View testID="closed-market-book" style={s.card}>
                <View style={s.section}>
                  <Text style={[s.body, s.bold]}>매수</Text>
                  <Text style={[s.body, s.bold]}>
                    {`내 주문 · ${won(price)} · 10주`}
                  </Text>
                  {buys.map((order) => (
                    <Body key={order.price}>
                      {`${won(order.price)} · ${order.quantity}주`}
                    </Body>
                  ))}
                </View>
                <View style={s.section}>
                  <Text style={[s.body, s.bold]}>매도</Text>
                  {sells.length ? (
                    sells.map((order) => (
                      <Body key={order.price}>
                        {`${won(order.price)} · ${order.quantity}주`}
                      </Body>
                    ))
                  ) : (
                    <Body>아직 접수된 주문 없음</Body>
                  )}
                </View>
              </View>
              <Values
                id="closed-market-status"
                rows={[
                  ['시각', ['장 마감 직후', '밤 22:00', '새벽 05:00', '08:30'][stage]],
                  ['현재가', '10,000원'],
                  ['지금까지 체결', '0건'],
                  [
                    '쌓인 주문',
                    `매수 ${10 + buys.reduce((sum, order) => sum + order.quantity, 0)}주 · 매도 ${sells.reduce((sum, order) => sum + order.quantity, 0)}주`,
                  ],
                ]}
              />
              {stage === 3 ? (
                <>
                  <Result
                    id="closed-market-pile-result"
                    title="주문은 늘었지만 가격은 그대로입니다"
                  >
                    <Body>
                      장이 닫혀 있는 동안에는 주문만 쌓이고 체결되지 않습니다. 현재가는 계속 10,000원입니다.
                    </Body>
                  </Result>
                  <LessonAction
                    id="closed-market-open"
                    label="다음 · 09:00 개장"
                    disabled={opened}
                    onPress={() => setOpened(true)}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </Section>
      ) : null}
      {opened && result && opening.status !== 'undetermined' ? (
        <Section id="closed-market-3" title="3. 09:00 개장: 한 가격으로 체결됩니다">
          <Body>
            쌓인 주문을 한꺼번에 모아, 가장 많이 체결되는 가격 하나를 시가로 정합니다.
          </Body>
          <View testID="closed-market-candidates" style={s.card}>
            <Text style={[s.body, s.bold]}>가격별 체결 가능 수량</Text>
            {auction.candidates.map((row) => (
              <Body key={row.price}>
                {`${won(row.price)}: 매수 ${row.buy}주 · 매도 ${row.sell}주 → ${row.quantity}주${row.price === result.price ? ' ← 시가' : ''}`}
              </Body>
            ))}
          </View>
          <Values
            id="closed-market-open-values"
            rows={[
              ['시가', `${won(result.price)} · ${result.quantity}주 체결`],
              ['전일 종가 대비', percent(changeRate(10000, result.price))],
            ]}
          />
          <CandleSeries
            id="closed-market-open-candle"
            timeline
            domain={priceDomain([10000, result.price])}
            items={[
              { label: '전 거래일 · 종가 10,000원', candle: ohlcFromPrices([10000]) },
              { label: '밤사이 · 체결 없음', candle: null },
              {
                label: `09:00 · 시가 ${won(result.price)}`,
                candle: ohlcFromPrices([result.price]),
              },
            ]}
          />
          <Result
            id="closed-market-my-result"
            title={
              opening.status === 'filled'
                ? `내 주문: ${won(opening.price)}에 체결`
                : '내 주문: 체결되지 않음'
            }
          >
            {opening.status === 'filled' ? (
              <>
                <Body>
                  {`${won(price)}까지 낼 생각이었지만 시가가 ${won(opening.price)}으로 정해져 ${won(opening.price)}에 ${opening.quantity}주가 체결되었습니다. 낸 가격보다 ${won(opening.saved)} 싸게 샀습니다.`}
                </Body>
                <Body>10,100원을 냈다면 시가보다 낮아 체결되지 않았을 것입니다.</Body>
              </>
            ) : (
              <>
                <Body>
                  {`시가 ${won(result.price)}이 낸 가격 ${won(price)}보다 높게 정해져 체결되지 않았습니다. 지정가 매수는 낸 가격 이하일 때만 체결됩니다.`}
                </Body>
                <Body>
                  {`10,300원을 냈다면 ${won(result.price)}에 체결되었을 것입니다.`}
                </Body>
              </>
            )}
          </Result>
          <Basis>
            단일가에서는 모두 같은 가격으로 체결되고, 매수 주문이 많으면 높은 가격부터 체결됩니다(가격 우선). 실제 규정에는 세부 규칙이 더 있습니다.
          </Basis>
          <LessonAction
            id="closed-market-finish"
            label="다음 · 정리"
            disabled={finished}
            onPress={() => setFinished(true)}
          />
        </Section>
      ) : null}
      {finished ? (
        <Section id="closed-market-4" title="4. 정리">
          <Takeaways
            items={[
              '장이 닫혀 있어도 주문은 쌓이지만, 체결은 장이 열리는 순간 한 번에 일어납니다.',
              '쌓인 주문은 한 가격(시가)으로 체결됩니다. 그 가격과 전일 종가의 차이가 갭입니다.',
              '개장 단일가에서 지정가 매수는 낸 가격 이하일 때 체결되고, 체결가는 낸 가격이 아니라 시가입니다.',
            ]}
          />
          <LessonAction
            id="closed-market-more"
            label={more ? '더 알아보기 접기' : '더 알아보기 열기'}
            secondary
            onPress={() => setMore((value) => !value)}
          />
          {more ? (
            <View testID="closed-market-more-text" style={s.section}>
              <Body>한국은 08:30부터 개장 전 주문을 접수하고 09:00에 시가를 정합니다.</Body>
              <Body>종가도 같은 방식입니다. 15:20~15:30에 주문을 모아 15:30에 종가를 정합니다.</Body>
              <Body>
                미국은 정규장 앞뒤로 장전(04:00~09:30 ET)·장후(16:00~20:00 ET) 거래가 따로 있습니다. NYSE Arca 시간대 예시입니다.
              </Body>
              <Body>암호화폐는 24시간 거래되어 이런 장 마감 공백이 없습니다.</Body>
            </View>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
