import React, { useState } from 'react';
import { Text, View } from 'react-native';
import {
  Body,
  LessonAction,
  Result,
  Section,
  Takeaways,
  lessonStyles as s,
} from './LessonUi';
import {
  Basis,
  CandleSeries,
  Choices,
  LessonPlot,
  Values,
} from './MarketLessonUi';
import {
  auctionBuys,
  auctionSells,
  calendarCases,
  sessionCases,
  sessionTrades,
} from './marketLessonData';
import {
  callAuction,
  changeRate,
  limitBuy,
  percent,
  priceDomain,
  sessionOhlc,
  usTradingSession,
} from './marketLessonCalculations';
import { won, type Quote } from './lessonCalculations';

export function SessionsLesson() {
  const [selected, setSelected] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [dateRecorded, setDateRecorded] = useState(false);
  const [calendar, setCalendar] = useState<string | null>(null);
  const session = sessionCases.find((item) => item.id === selected);
  const us = date ? usTradingSession(date) : null;
  const day = calendarCases.find((item) => item.id === calendar);
  const dayUs =
    day?.market === 'NYSE' && !day.closed
      ? usTradingSession(day.date, day.early)
      : null;
  return (
    <>
      <Body>
        시장이 열려 있다는 말만으로 체결 방식을 알 수는 없습니다. 거래소, 거래
        구간과 거래일을 함께 확인합니다.
      </Body>
      <Section title="실습 A · 한국시장의 하루" id="sessions-a">
        <Basis>
          KRX 일반주식 / NXT 대상 종목 · 한국시간(KST). KRX 정규장은
          09:00~15:30입니다.
        </Basis>
        <Body>
          특히 같은 08:35의 개장 주문 수집과 장전 종가거래를 각각 선택해
          비교하세요.
        </Body>
        <Choices<string>
          id="session"
          options={sessionCases.map((item) => ({
            value: item.id,
            label: item.label,
          }))}
          value={selected}
          onChange={setSelected}
          disabled={recorded}
        />
        {session ? (
          <Result id="session-result" title="선택한 거래 구간">
            <Values
              rows={[
                ['시장', session.market],
                ['선택 시각', session.time],
                ['거래 구간', session.session],
                ['운영 시간', session.hours],
                [
                  '주문 접수',
                  session.receive
                    ? '가능 · 대상 종목과 허용 주문유형 범위 내'
                    : '불가',
                ],
                [
                  '실제 체결',
                  session.execute
                    ? '체결 상대와 가격 조건이 맞으면 체결 가능'
                    : '지금은 체결하지 않고 주문을 수집',
                ],
                ['체결가격 기준', session.price],
              ]}
            />
            <Body>
              같은 시각에도 선택한 구간에 따라 주문을 모으거나 정해진 종가로
              거래할 수 있습니다. NXT는 KRX와 별도 시장이며, 모든 종목과
              증권사가 모든 구간을 지원하는 것은 아닙니다.
            </Body>
            <Body>
              KRX 애프터마켓은 연속매매이며 대상 종목과 허용 주문유형에 제한이
              있습니다. 거래 구간의 시장 제도와 이 앱의 주문 지원 범위는
              구분합니다.
            </Body>
          </Result>
        ) : (
          <Body>거래 구간을 선택하면 접수·체결 상태가 표시됩니다.</Body>
        )}
        <LessonAction
          id="session-record"
          label="선택한 거래 구간 기록"
          onPress={() => setRecorded(true)}
          disabled={!session || recorded}
        />
      </Section>
      {recorded ? (
        <Section title="실습 B · 미국 거래일을 한국시간으로" id="sessions-b">
          <Basis>NYSE 정규장 · 미국 동부시간(ET) 09:30~16:00</Basis>
          <Choices<string>
            id="us-date"
            options={[
              { value: '2026-01-07', label: '2026-01-07 · 겨울 거래일' },
              { value: '2026-07-08', label: '2026-07-08 · 여름 거래일' },
            ]}
            value={date}
            onChange={setDate}
            disabled={dateRecorded}
          />
          {us ? (
            <Result title="날짜에 따른 시간 변환" id="us-date-result">
              <Values
                rows={[
                  [
                    '서머타임',
                    us.daylightSaving ? '적용 (EDT)' : '미적용 (EST)',
                  ],
                  ['개장 · ET', us.openEt],
                  ['마감 · ET', us.closeEt],
                  ['개장 · 한국시간', us.openKst],
                  ['마감 · 한국시간', `${us.closeKst} · 다음 날`],
                ]}
              />
              <Body>
                날짜의 실제 시간대 규칙을 적용했습니다. 미국 동부의 서머타임
                전환에 따라 한국에서 보는 시각이 한 시간 달라집니다.
              </Body>
              <Body>
                NYSE Arca의 대표 확장 구간은 장전 04:00~09:30 ET, 장후
                16:00~20:00 ET입니다. 모든 미국 계좌의 공통 이용시간이 아니며,
                야간거래 서비스도 정규장과 구분해야 합니다.
              </Body>
            </Result>
          ) : null}
          <LessonAction
            id="us-date-record"
            label="선택한 거래일 시간 기록"
            onPress={() => setDateRecorded(true)}
            disabled={!us || dateRecorded}
          />
        </Section>
      ) : null}
      {dateRecorded ? (
        <Section title="실습 C · 거래일과 휴장일" id="sessions-c">
          <Choices<string>
            id="calendar"
            options={calendarCases.map((item) => ({
              value: item.id,
              label: `${item.label} · ${item.date}`,
            }))}
            value={calendar}
            onChange={setCalendar}
          />
          {day ? (
            <Result title="선택한 날짜의 시간표" id="calendar-result">
              <Values
                rows={[
                  ['시장·날짜', `${day.market} · ${day.date}`],
                  ['상태', day.reason],
                  [
                    '주문·체결',
                    day.closed
                      ? '휴장 · 해당 시장의 거래소 주문 접수와 체결 없음'
                      : '선택 시장의 해당 거래 구간에서 접수·체결 가능',
                  ],
                  [
                    '정규장',
                    day.closed
                      ? '운영하지 않음'
                      : dayUs
                        ? `${dayUs.openEt} ~ ${dayUs.closeEt} ET`
                        : '09:00~15:30 KST',
                  ],
                  [
                    '한국시간',
                    day.closed
                      ? '해당 거래일 휴장'
                      : dayUs
                        ? `${dayUs.openKst} ~ ${dayUs.closeKst}`
                        : `${day.date} 09:00~15:30`,
                  ],
                ]}
              />
              {day.early ? (
                <Body>
                  2026-11-27은 정규장이 13:00 ET에 끝납니다. NYSE Arca 등 공지에
                  명시된 시장의 이날 장후 거래도 17:00 ET에 종료합니다.
                </Body>
              ) : null}
              <Body>
                휴장·조기 폐장 일정이 평일의 일반 시간표보다 우선합니다. 한국
                휴일과 미국 휴일은 같지 않습니다. 증권사의 예약 주문 접수는
                거래소의 주문 접수와 별개입니다.
              </Body>
            </Result>
          ) : null}
          {day ? (
            <Takeaways
              items={[
                '거래소·거래 구간·거래일을 함께 확인합니다.',
                '주문 접수 가능 시간이 곧 체결 가능 시간은 아닙니다.',
                '미국 시간은 거래일의 서머타임과 한국의 익일 날짜까지 확인합니다.',
                '휴장과 조기 폐장은 일반 시간표의 예외입니다.',
              ]}
            />
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

function OrdersTable({ buys, sells }: { buys: Quote[]; sells: Quote[] }) {
  return (
    <View style={s.card}>
      {[
        ['매수', buys],
        ['매도', sells],
      ].map(([side, orders]) => (
        <View key={side as string} style={s.section}>
          <Text style={[s.body, s.bold]}>{side as string}</Text>
          {(orders as Quote[]).length ? (
            (orders as Quote[]).map((order) => (
              <Text key={order.price} style={s.body}>
                {won(order.price)} · {order.quantity}주
              </Text>
            ))
          ) : (
            <Body>아직 접수된 주문 없음</Body>
          )}
        </View>
      ))}
    </View>
  );
}
function LimitResult({ asks, id }: { asks: Quote[]; id: string }) {
  const result = limitBuy(asks, 20, 10050);
  return (
    <Result title="지정가 매수 결과" id={id}>
      {result.fills.map((fill) => (
        <Body key={fill.price}>
          {won(fill.price)} × {fill.quantity}주
        </Body>
      ))}
      <Values
        rows={[
          ['가격 상한', won(10050)],
          ['체결 수량', `${result.quantity}주`],
          ['미체결 수량', `${result.remaining}주`],
          [
            '평균 체결가',
            result.average === null ? '체결 없음' : won(result.average),
          ],
        ]}
      />
    </Result>
  );
}
export function AuctionsLesson() {
  const [batches, setBatches] = useState(0);
  const [matched, setMatched] = useState(false);
  const [closing, setClosing] = useState(0);
  const [regular, setRegular] = useState(false);
  const [extended, setExtended] = useState(false);
  const buys = auctionBuys.slice(0, batches),
    sells = auctionSells.slice(0, batches);
  const auction = callAuction(buys, sells);
  const closingAuction = callAuction(auctionBuys, auctionSells).result;
  const regularAsks = [{ price: 10010, quantity: 500 }];
  const extendedAsks = [
    { price: 10010, quantity: 5 },
    { price: 10050, quantity: 10 },
    { price: 10100, quantity: 20 },
  ];
  return (
    <>
      <Basis>KRX 일반주식 기준 · 가격과 주문은 가상 예제</Basis>
      <Section title="실습 A · 주문을 모아 시가 결정" id="auction-a">
        <Body>
          세 묶음의 지정가 주문을 접수한 뒤 체결 가능한 수량을 비교합니다. 접수
          중에는 거래가 발생하지 않습니다.
        </Body>
        <LessonAction
          id="auction-collect"
          label={`지정가 주문 묶음 접수 (${batches}/3)`}
          disabled={batches === 3}
          onPress={() => setBatches(Math.min(3, batches + 1))}
        />
        <OrdersTable buys={buys} sells={sells} />
        <Values
          id="auction-collection"
          rows={[
            ['최근 체결가격', won(matched ? auction.result.price : 10000)],
            ['이번 체결량', `${matched ? auction.result.quantity : 0}주`],
            [
              '예상체결가',
              matched
                ? '수집 종료 · 실제 시가 확정'
                : auction.result
                  ? won(auction.result.price)
                  : '주문 부족 · 아직 계산 전',
            ],
          ]}
        />
        {batches > 0 ? (
          <View style={s.card} testID="auction-candidates">
            <Text style={[s.body, s.bold]}>후보 가격별 체결 가능 수량</Text>
            {auction.candidates.map((row) => (
              <Body key={row.price}>
                {won(row.price)}: 매수 가능 {row.buy}주 / 매도 가능 {row.sell}주
                → 체결 가능 {row.quantity}주
              </Body>
            ))}
          </View>
        ) : null}
        <LessonAction
          id="auction-match"
          label="수집 종료 · 개장 단일가 체결"
          disabled={batches < 3 || matched}
          onPress={() => setMatched(true)}
        />
        {matched ? (
          <Result title="개장 체결 결과" id="auction-result">
            <Body>
              {won(auction.result.price)}에서 {auction.result.quantity}주가
              단일가격으로 체결되어 시가가 됩니다. 수집 중 예상체결가는 실제
              체결가격이 아니며 추가·취소 주문에 따라 달라질 수 있습니다.
            </Body>
            <Body>
              접수 매수 {buys.reduce((sum, row) => sum + row.quantity, 0)}주와
              매도 {sells.reduce((sum, row) => sum + row.quantity, 0)}주가 모두
              체결된 것은 아닙니다. 각 측의 미체결 수량은 매수{' '}
              {buys.reduce((sum, row) => sum + row.quantity, 0) -
                auction.result.quantity}
              주, 매도{' '}
              {sells.reduce((sum, row) => sum + row.quantity, 0) -
                auction.result.quantity}
              주입니다.
            </Body>
            <Basis>
              체결량이 가장 큰 후보가 하나인 교육 예제입니다. 실제 단일가에는
              동률 처리·배분·종료 시점 등의 세부 규정이 적용됩니다.
            </Basis>
          </Result>
        ) : null}
      </Section>
      {matched ? (
        <Section title="실습 B · 종가와 장후 가격" id="auction-b">
          <Body>
            별도 마감 예제의 단일가 직전 마지막 체결가는 {won(10180)}입니다. KRX
            종가 주문 수집은 15:20~15:30입니다.
          </Body>
          <LessonAction
            id="close-collect"
            label="종가 단일가 주문 수집"
            disabled={closing > 0}
            onPress={() => setClosing(1)}
          />
          {closing > 0 ? (
            <>
              <Values
                rows={[
                  ['주문 수집 중 최근 체결가', won(10180)],
                  ['수집 중 예상체결가', won(closingAuction.price)],
                  ['이 수집 단계의 체결량', '0주'],
                ]}
              />
              <LessonAction
                id="close-match"
                label="15:30 · 정규장 종가 확정"
                disabled={closing > 1}
                onPress={() => setClosing(2)}
              />
            </>
          ) : null}
          {closing >= 2 ? (
            <>
              <Result title="정규장 마감 결과" id="close-result">
                <Body>
                  종가 단일가에서 {closingAuction.quantity}주가{' '}
                  {won(closingAuction.price)}에 체결되었습니다. 정규장 종가는{' '}
                  {won(closingAuction.price)}으로 확정됩니다.
                </Body>
              </Result>
              <LessonAction
                id="close-after"
                label="17:00 · 애프터마켓에서 10,250원 체결"
                disabled={closing > 2}
                onPress={() => setClosing(3)}
              />
            </>
          ) : null}
          {closing === 3 ? (
            <Result title="장후 체결 결과" id="after-close-result">
              <Values
                rows={[
                  ['정규장 종가', won(closingAuction.price)],
                  ['장후 마지막 체결가격', won(10250)],
                ]}
              />
              <Body>
                현재 표시가격은 선택한 거래 구간의 최근 체결가격일 수 있습니다.
                장후 체결은 이미 확정된 정규장 종가를 덮어쓰지 않습니다. 이
                체결은 종가로만 거래하는 시간외 종가거래가 아니라 KRX 애프터마켓
                예제입니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {closing === 3 ? (
        <Section title="실습 C · 같은 가격 조건, 다른 잔량" id="auction-c">
          <Body>
            10,050원 이하에서 20주 지정가 매수를 두 환경에 각각 적용합니다.
          </Body>
          <OrdersTable buys={[]} sells={regularAsks} />
          <LessonAction
            id="session-regular-buy"
            label="정규장 예제 · 20주 지정가 매수"
            disabled={regular}
            onPress={() => setRegular(true)}
          />
          {regular ? (
            <>
              <LimitResult id="session-regular-result" asks={regularAsks} />
              <Body>
                한 가격의 대기 물량으로 주문 전체를 체결할 수 있습니다.
              </Body>
              <Section title="이어서 · 잔량이 적은 시간외 예제">
                <OrdersTable buys={[]} sells={extendedAsks} />
                <LessonAction
                  id="session-extended-buy"
                  label="시간외 예제 · 같은 지정가 매수"
                  disabled={extended}
                  onPress={() => setExtended(true)}
                />
                {extended ? (
                  <>
                    <LimitResult
                      id="session-extended-result"
                      asks={extendedAsks}
                    />
                    <Body>
                      10,100원은 매수가격 상한을 넘으므로 체결하지 않습니다.
                      시간외에는 잔량과 허용 주문유형이 다를 수 있으며 시장가가
                      항상 가능한 것은 아닙니다. 장전·장후의 가격 변화로 정규장
                      방향을 예측할 수 있다는 뜻도 아닙니다.
                    </Body>
                  </>
                ) : null}
              </Section>
            </>
          ) : null}
          {extended ? (
            <Takeaways
              items={[
                '단일가는 주문을 모은 뒤 하나의 가격으로 체결합니다.',
                '예상체결가·정규장 종가·장후 최근 체결가격의 기준은 다릅니다.',
                '지정가의 가격 조건을 넘으면 대기 물량이 있어도 체결하지 않습니다.',
              ]}
            />
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

export function GapsLesson() {
  const [opened, setOpened] = useState(false);
  const [closed, setClosed] = useState(false);
  const [extended, setExtended] = useState(false);
  const [viewed, setViewed] = useState(false);
  const prior = sessionTrades[0].price;
  const regular = sessionOhlc(sessionTrades, false).candle;
  const display = sessionOhlc(sessionTrades, extended);
  const domain = priceDomain(sessionTrades.map((trade) => trade.price));
  return (
    <>
      <Basis>KRX 정규장과 NXT 장전·장후를 합친 가상 기록 · 기업행동 없음</Basis>
      <Section title="실습 A · 다음 거래일 개장" id="gaps-a">
        <Body>
          정규장만 표시한 차트에서 전 거래일 종가와 다음 시가를 확인합니다.
        </Body>
        <LessonAction
          id="gap-open"
          label="다음 거래일 개장 진행"
          disabled={opened}
          onPress={() => setOpened(true)}
        />
        <LessonPlot
          id="gap-plot"
          domain={domain}
          labels={['전 거래일 종가', '정규장 거래 공백', '다음 시가']}
          series={[
            {
              name: '정규장 기록',
              values: [prior, null, opened ? regular.open : null],
            },
          ]}
        />
        {opened ? (
          <Result title="개장 결과" id="gap-result">
            <Body>
              전일 종가 {won(prior)}와 다음 시가 {won(regular.open)} 사이에{' '}
              {won(regular.open - prior)}의 갭이 생겼습니다. 정규장 거래가 없는
              동안에도 정보와 주문 의사는 바뀔 수 있습니다.
            </Body>
            <Body>
              정규장 차트의 빈 구간이 다른 시장이나 장전·장후의 무거래까지
              뜻하지는 않습니다. 갭이 반드시 메워진다는 규칙도 없습니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {opened ? (
        <Section title="실습 B · 음봉과 전일 대비 상승" id="gaps-b">
          <LessonAction
            id="gap-close"
            label="당일 종가 확인"
            disabled={closed}
            onPress={() => setClosed(true)}
          />
          {closed ? (
            <Result title="두 가지 비교 기준" id="gap-close-result">
              <CandleSeries
                id="gap-candle"
                domain={domain}
                items={[{ label: '당일 정규장', candle: regular }]}
              />
              <Values
                rows={[
                  [
                    '캔들 방향',
                    regular.close < regular.open
                      ? '음봉 · 종가 < 시가'
                      : '양봉 · 종가 > 시가',
                  ],
                  ['전일 대비', percent(changeRate(prior, regular.close))],
                ]}
              />
              <Body>
                시가 {won(regular.open)}보다 종가 {won(regular.close)}가 낮아
                음봉이지만, 전일 종가 {won(prior)}보다 높아 전일 대비
                상승입니다. 기업행동이 있는 날의 기준가격과 차트 조정은
                ‘조정주가 읽기’에서 구분합니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {closed ? (
        <Section title="실습 C · 같은 기록, 다른 표시 범위" id="gaps-c">
          <Choices
            id="gap-scope"
            options={[
              { value: 'regular', label: '정규장만' },
              { value: 'extended', label: '장전·정규장·장후 포함' },
            ]}
            value={extended ? 'extended' : 'regular'}
            onChange={(value) => {
              setExtended(value === 'extended');
              setViewed(true);
            }}
          />
          <CandleSeries
            id="gap-scope-candle"
            domain={domain}
            items={[
              {
                label: extended
                  ? '확장 구간 자체 집계 · 공식 정규장 OHLC 아님'
                  : '가상 정규장 OHLC',
                candle: display.candle,
              },
            ]}
          />
          <Values
            rows={display.records.map(
              (record) =>
                [
                  `${record.time} · ${record.session === 'regular' ? '정규장' : record.session === 'pre' ? '장전' : '장후'}`,
                  won(record.price),
                ] as const,
            )}
          />
          {viewed ? (
            <Result title="표시 범위 해석">
              <Body>
                두 화면은 같은 원본 거래 기록을 구간으로 필터링해 집계합니다.
                포함 구간이 달라지면 시가·고가·저가·종가도 달라질 수 있습니다.
                거래 구간 밖 시간을 접는 차트와 공백을 남기는 차트는 같은 기록을
                다르게 배치할 수 있습니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {viewed ? (
        <Takeaways
          items={[
            '정규장 차트의 공백이 다른 거래 구간에서도 거래가 없었다는 뜻은 아닙니다.',
            '캔들 방향은 시가와 종가, 전일 대비 등락률은 전 거래일 기준과 비교합니다.',
            '표시 구간을 바꾸면 같은 기록의 OHLC 집계값도 달라질 수 있습니다.',
          ]}
        />
      ) : null}
    </>
  );
}

export function SafeguardsLesson() {
  const [halt, setHalt] = useState(0);
  const [vi, setVi] = useState(0);
  const [orderPrice, setOrderPrice] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [upper, setUpper] = useState(false);
  const [lower, setLower] = useState(false);
  const base = 10000,
    floor = base * 0.7,
    ceiling = base * 1.3;
  const viResult = callAuction(auctionBuys, auctionSells).result;
  const viLabels = [
    '연속매매',
    'VI 발동',
    '단일가 주문 수집',
    '단일가 체결',
    '연속매매 재개',
  ];
  return (
    <>
      <Basis>KRX 일반주식 · 기업행동 없는 가상 사례</Basis>
      <Section title="실습 A · 거래정지와 재개" id="halt-a">
        <LessonAction
          id="halt-apply"
          label="가상 거래정지 적용"
          disabled={halt > 0}
          onPress={() => setHalt(1)}
        />
        <LessonPlot
          id="halt-plot"
          domain={priceDomain([10000, 10100, 10400])}
          labels={['09:50', '10:00', '10:05~10:30', '재개 10:31']}
          series={[
            {
              name: halt
                ? '거래정지 구간을 남긴 체결 기록'
                : '거래정지 전 체결 기록',
              values: [10000, 10100, null, null],
            },
          ]}
        />
        {halt > 0 ? (
          <>
            <Result title="거래정지 구간" id="halt-result">
              <Body>
                10:05~10:30은 가상 거래정지 구간입니다. 거래 기록이 없으므로
                가격 0의 캔들을 만들지 않습니다. 데이터 누락과 실제 거래정지는
                원인이 다르며 차트 공백만으로 원인을 단정할 수 없습니다.
              </Body>
            </Result>
            <LessonAction
              id="halt-resume"
              label="거래 재개 · 첫 체결 확인"
              disabled={halt === 2}
              onPress={() => setHalt(2)}
            />
          </>
        ) : null}
        {halt === 2 ? (
          <Result title="재개 후 첫 체결" id="halt-resume-result">
            <LessonPlot
              id="halt-resumed-plot"
              domain={priceDomain([10000, 10100, 10400])}
              labels={['09:50', '10:00', '10:05~10:30', '재개 10:31']}
              series={[
                {
                  name: '거래 재개를 포함한 기록',
                  values: [10000, 10100, null, 10400],
                },
              ]}
            />
            <Body>
              재개 후 첫 거래가 {won(10400)}에 체결되었습니다. 거래정지 이전
              가격과 다를 수 있습니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {halt === 2 ? (
        <Section title="실습 B · VI의 완화 구간" id="vi-b">
          <Body>
            VI는 급격한 가격 변동에 대응해 매매 방식을 잠시 바꾸는 장치입니다.
            일반 거래정지와 구분합니다.
          </Body>
          <LessonAction
            id="vi-step"
            label={
              [
                'VI 발동 상황 적용',
                '완화 구간에 지정가 주문 접수',
                '개념상 2분 경과 · 단일가 체결',
                '연속매매 재개',
                'VI 체험 완료',
              ][vi]
            }
            disabled={vi === 4}
            onPress={() => setVi(Math.min(4, vi + 1))}
          />
          <Values
            id="vi-state"
            rows={[
              ['매매 상태', viLabels[vi]],
              [
                '교육상 시각',
                ['10:00:00', '10:00:01', '10:01:00', '10:02:01', '10:02:02'][
                  vi
                ],
              ],
              [
                '주문 접수',
                vi === 1 || vi === 2
                  ? '단일가 주문 접수 가능'
                  : '해당 매매 방식에 따라 가능',
              ],
              ['현재가', won(vi < 3 ? 10000 : viResult.price)],
              ['이번 체결량', `${vi < 3 ? 0 : viResult.quantity}주`],
            ]}
          />
          {vi === 2 ? (
            <OrdersTable buys={auctionBuys} sells={auctionSells} />
          ) : null}
          <Basis>
            통상 2분의 완화 구간을 버튼으로 짧게 재현합니다. 화면 조작 시간은
            실제 제도의 대기시간이 아닙니다. 발동 비율은 시장·종목·유형에 따라
            다릅니다.
          </Basis>
          {vi === 4 ? (
            <Result title="VI 결과" id="vi-result">
              <Body>
                주문 접수까지 모두 중단한 것이 아닙니다. 단일가 주문을 모아{' '}
                {won(viResult.price)}에 {viResult.quantity}주를 체결한 뒤
                연속매매로 돌아왔습니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {vi === 4 ? (
        <Section title="실습 C · 가격제한과 체결 상대" id="limits-c">
          <Values
            rows={[
              ['기준가격', won(base)],
              ['일반주식 상한가', won(ceiling)],
              ['일반주식 하한가', won(floor)],
            ]}
          />
          <Choices<number>
            id="limit-price"
            options={[6800, 7000, 10000, 13000, 13200].map((value) => ({
              value,
              label: won(value),
            }))}
            value={orderPrice}
            onChange={setOrderPrice}
            disabled={submitted}
          />
          <LessonAction
            id="limit-submit"
            label="선택한 주문가격 검사"
            disabled={orderPrice === null || submitted}
            onPress={() => setSubmitted(true)}
          />
          {submitted ? (
            <>
              <Result title="주문가격 검사 결과" id="limit-price-result">
                <Body>
                  {won(orderPrice)}:{' '}
                  {orderPrice < floor || orderPrice > ceiling
                    ? '가격제한 범위 밖 · 교육 예제 주문 거절'
                    : '가격제한 범위 안 · 가격 조건 허용, 체결은 별도'}
                </Body>
              </Result>
              <LessonAction
                id="limit-upper"
                label="상한가 매수 · 매도 주문 없음"
                disabled={upper}
                onPress={() => setUpper(true)}
              />
            </>
          ) : null}
          {upper ? (
            <>
              <Result title="상한가에서의 미체결" id="limit-upper-result">
                <Body>
                  {won(ceiling)}에 매수하려 해도 대기 매도 주문이 없으면
                  체결량은 0주입니다.
                </Body>
              </Result>
              <LessonAction
                id="limit-lower"
                label="하한가 매도 · 매수 주문 없음"
                disabled={lower}
                onPress={() => setLower(true)}
              />
            </>
          ) : null}
          {lower ? (
            <>
              <Result title="하한가에서의 미체결" id="limit-lower-result">
                <Body>
                  {won(floor)}에 매도하려 해도 대기 매수 주문이 없으면 체결량은
                  0주입니다.
                </Body>
                <Body>
                  ±30%는 이 KRX 일반주식 사례의 일일 가격제한입니다.
                  미국시장·신규상장 첫날·특수상품에 일괄 적용하지 않으며 투자
                  손실의 최대 한도도 아닙니다.
                </Body>
              </Result>
              <Takeaways
                items={[
                  '거래정지, VI, 가격제한은 서로 다른 제도입니다.',
                  '허용 가격이라도 체결 상대가 없으면 거래가 성사되지 않습니다.',
                  '거래 공백은 공식 시장 상태와 함께 해석합니다.',
                ]}
              />
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
