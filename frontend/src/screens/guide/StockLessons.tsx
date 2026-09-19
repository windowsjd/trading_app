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
import { Basis, CandleSeries, Choices, Values } from './MarketLessonUi';
import {
  auctionBuys,
  auctionSells,
  calendarCases,
  marketExamples,
  sessionTrades,
} from './marketLessonData';
import {
  callAuction,
  changeRate,
  percent,
  priceDomain,
  sessionOhlc,
  sessionTimeline,
  usTradingSession,
} from './marketLessonCalculations';
import { won, ohlcFromPrices, type Quote } from './lessonCalculations';

export function SessionsLesson() {
  const [extended, setExtended] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [recorded, setRecorded] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [dateRecorded, setDateRecorded] = useState(false);
  const [calendar, setCalendar] = useState<string | null>(null);
  const us = date ? usTradingSession(date) : null;
  const day = calendarCases.find((item) => item.id === calendar);
  const dayUs =
    day?.market === 'NYSE' && !day.closed
      ? usTradingSession(day.date, day.early)
      : null;
  return (
    <>
      <Body>
        정규장(Regular Session)은 시장이 정한 기본 거래 구간입니다. 장전
        거래(Pre-Market)는 정규장 이전, 장후 거래(After-Hours)는 이후에
        이루어지는 거래입니다. 한국과 미국의 하루를 같은 순서로 비교합니다.
      </Body>
      <Section title="실습 A · 거래시간과 캔들이 생기는 구간" id="sessions-a">
        <Body>
          정규장만 보기와 시간외 포함을 차례로 눌러보세요. 각 시장의 같은 원본
          기록에서 포함 구간만 바꿉니다. 캔들 수와 고가·저가, 회색 공백을
          비교하세요.
        </Body>
        <Choices
          id="session-scope"
          options={[
            { value: 'regular', label: '정규장만 보기' },
            { value: 'extended', label: '시간외 포함' },
          ]}
          value={extended ? 'extended' : 'regular'}
          disabled={recorded}
          onChange={(value) => {
            setExtended(value === 'extended');
            setScopes((values) =>
              values.includes(value) ? values : [...values, value],
            );
          }}
        />
        {marketExamples.map((market) => {
          const result = sessionOhlc(market.trades, extended);
          const items = sessionTimeline(market.trades, extended);
          const format = (price: number) =>
            `${price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${market.currency}`;
          return (
            <Section
              key={market.id}
              title={market.name}
              id={`session-${market.id}`}
            >
              <Basis>
                모든 시각은 {market.zone} · 정상 거래일 가상 가격 기록
              </Basis>
              <Values rows={market.hours} />
              <CandleSeries
                id={`session-${market.id}-candles`}
                timeline
                items={items}
                formatPrice={format}
                domain={priceDomain(market.trades.map((r) => r.price))}
              />
              <Values
                id={`session-${market.id}-summary`}
                rows={[
                  [
                    '당일 예제 캔들 수',
                    `${items.filter((item) => item.candle).length - 1}개 · 실제 하루 전체 캔들 수가 아님`,
                  ],
                  ['당일 포함 기록의 고가', format(result.candle.high)],
                  ['당일 포함 기록의 저가', format(result.candle.low)],
                  [
                    '차트의 거래 공백',
                    extended
                      ? '밤사이 공백은 남고, 장전·장후 기록이 나타남'
                      : '전 거래일 종료 → 밤사이 공백 → 다음 정규장 개장 · 시간외 기록 제외',
                  ],
                ]}
              />
            </Section>
          );
        })}
        {scopes.length ? (
          <Result title="세션을 바꿔 본 결과" id="session-result">
            <Body>
              정규장만 선택하면 장전·장후 칸이 비어 있습니다. 시간외를 포함하면
              그 구간의 캔들이 생기고 당일 고가·저가도 달라질 수 있습니다. 한국
              예제의 장전 종가거래는 전일 종가로 체결되며 개장 단일가 주문
              수집과 구분됩니다.
            </Body>
            <Body>
              미국 장전·장후 이용 가능 시간은 시장과 증권사에 따라 달라집니다.
              여기서는 NYSE Arca 시간대를 사용합니다. 시간외의 유동성·주문유형도
              정규장과 다를 수 있습니다.
            </Body>
          </Result>
        ) : null}
        <LessonAction
          id="session-record"
          label="두 표시 범위 비교 완료"
          disabled={scopes.length < 2 || recorded}
          onPress={() => setRecorded(true)}
        />
      </Section>
      {recorded ? (
        <Section
          title="실습 B · 미국 정규장을 한국시간으로 비교"
          id="sessions-b"
        >
          <Body>
            ET는 미국 동부시간입니다. 정규장 09:30~16:00 ET는 같지만 서머타임에
            따라 한국에서 보는 시간이 한 시간 달라집니다. 겨울·여름 날짜를
            선택하세요.
          </Body>
          <Choices<string>
            id="us-date"
            options={[
              { value: '2026-01-07', label: '2026-01-07 · 서머타임 미적용' },
              { value: '2026-07-08', label: '2026-07-08 · 서머타임 적용' },
            ]}
            value={date}
            onChange={setDate}
            disabled={dateRecorded}
          />
          {us ? (
            <Result title="한국·미국 정규장 시각" id="us-date-result">
              <Values
                rows={[
                  ['한국 정규장 · KST', '09:00~15:30'],
                  ['미국 정규장 · ET', `${us.openEt} ~ ${us.closeEt}`],
                  [
                    '서머타임',
                    us.daylightSaving ? '적용 (EDT)' : '미적용 (EST)',
                  ],
                  ['미국 개장 · 한국시간', us.openKst],
                  ['미국 마감 · 한국시간', `${us.closeKst} · 다음 날`],
                ]}
              />
              <Body>
                미적용일은 23:30~다음 날 06:00, 적용일은 22:30~다음 날
                05:00입니다. 날짜와 다음 날 여부까지 함께 읽습니다.
              </Body>
            </Result>
          ) : null}
          <LessonAction
            id="us-date-record"
            label="시간 비교 결과 기록"
            disabled={!us || dateRecorded}
            onPress={() => setDateRecorded(true)}
          />
        </Section>
      ) : null}
      {dateRecorded ? (
        <Section title="실습 C · 휴장과 조기 폐장" id="sessions-c">
          <Body>
            휴장(Market Holiday)은 해당 시장이 쉬는 날입니다. 조기 폐장(Early
            Close)은 평소보다 일찍 거래를 마치는 날입니다. 같은 날짜에도 한국과
            미국의 일정이 다를 수 있습니다.
          </Body>
          <Body>날짜를 눌러 일반 시간표가 어떻게 바뀌는지 확인하세요.</Body>
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
            <>
              <Result title="선택한 날짜의 거래시간" id="calendar-result">
                <Values
                  rows={[
                    ['시장·날짜', `${day.market} · ${day.date}`],
                    ['상태', day.reason],
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
                <Body>
                  휴장·조기 폐장 일정이 일반 시간표보다 우선합니다. 미국 예제의
                  2026-11-27은 정규장이 13:00 ET에 끝납니다. 이날 NYSE Arca
                  장후도 17:00 ET에 종료합니다.
                </Body>
              </Result>
              <Takeaways
                items={[
                  '거래시간은 시장·세션·거래일에 따라 다릅니다.',
                  '어떤 세션을 포함하는지에 따라 캔들 수·가격 범위·거래 공백이 달라집니다.',
                  '미국 정규장은 서머타임과 한국의 익일 날짜까지 확인합니다.',
                ]}
              />
            </>
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
export function AuctionsLesson() {
  const [batches, setBatches] = useState(0);
  const [matched, setMatched] = useState(false);
  const [closing, setClosing] = useState(0);
  const [usOpen, setUsOpen] = useState(false);
  const [usClose, setUsClose] = useState(false);
  const buys = auctionBuys.slice(0, batches),
    sells = auctionSells.slice(0, batches);
  const auction = callAuction(buys, sells);
  const closingAuction = callAuction(auctionBuys, auctionSells).result;
  return (
    <>
      <Basis>KRX 일반주식 기준 · 가격과 주문은 가상 예제</Basis>
      <Section title="실습 A · 주문을 모아 시가 결정" id="auction-a">
        <Body>
          단일가는 주문을 모은 뒤 하나의 가격으로 체결하는 방식입니다.
          08:30~09:00에 세 묶음의 가상 지정가 주문을 제출하세요. 즉시 체결되지
          않고 개장 전 주문이 모입니다. 개장을 진행하면 시가와 정규장 첫 캔들이
          만들어집니다.
        </Body>
        <LessonAction
          id="auction-collect"
          label={`개장 전 가상 주문 제출 (${batches}/3)`}
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
            <CandleSeries
              id="auction-open-candle"
              domain={priceDomain([10000, 10200])}
              timeline
              items={[
                { label: '개장 전 · 주문 수집만, 새 캔들 없음', candle: null },
                {
                  label: '09:00 · 시가 결정과 첫 캔들의 시작',
                  candle: ohlcFromPrices([auction.result.price]),
                },
              ]}
            />
            <Body>
              처음 한 번의 체결만 있어 시가·고가·저가·종가가 같습니다. 이후 같은
              시간 구간에 체결이 이어지면 첫 캔들의 몸통과 꼬리가 만들어집니다.
            </Body>
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
                <CandleSeries
                  id="auction-close-candle"
                  domain={priceDomain([10180, closingAuction.price])}
                  timeline
                  items={[
                    {
                      label: '장중 마지막 체결 · 10,180원',
                      candle: ohlcFromPrices([10180]),
                    },
                    {
                      label: '15:20~15:30 주문 수집 · 새 체결 없음',
                      candle: null,
                    },
                    {
                      label: '15:30 종가 단일가 · 정규장 마지막 체결',
                      candle: ohlcFromPrices([closingAuction.price]),
                    },
                  ]}
                />
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
                장후 체결은 이미 확정된 정규장 종가를 덮어쓰지 않습니다. 이
                예제는 당일 종가로만 거래하는 시간외 종가거래 이후의 KRX
                애프터마켓입니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {closing === 3 ? (
        <Section title="실습 C · 미국 개장·마감과 비교" id="auction-c">
          <Body>
            미국에도 개장·마감 경매가 있습니다. NYSE 정규장 개장 09:30 ET와 마감
            16:00 ET에 가격이 형성되는 예시를 눌러보세요. 경매는 주문을 모아
            가격을 결정하는 과정이며 장중의 연속 체결과 다를 수 있습니다.
          </Body>
          <LessonAction
            id="auction-us-open"
            label="09:30 ET · 개장 경매 체결 보기"
            disabled={usOpen}
            onPress={() => setUsOpen(true)}
          />
          {usOpen ? (
            <>
              <Result title="미국 정규장 첫 캔들" id="auction-us-open-result">
                <CandleSeries
                  id="auction-us-open-candle"
                  domain={priceDomain([100, 102])}
                  formatPrice={(n) => `${n.toLocaleString('ko-KR')}달러`}
                  items={[
                    {
                      label: '개장 경매의 첫 체결 · 시가 102달러',
                      candle: ohlcFromPrices([102]),
                    },
                  ]}
                />
                <Body>
                  개장 가격이 정규장 첫 캔들의 출발점이 됩니다. 한국과 미국의
                  주문 종류·참가 조건·경매 규칙이 모두 같다는 뜻은 아닙니다.
                </Body>
              </Result>
              <Body>
                장중 마지막 체결 101.8달러 이후 마감 경매에서 102.2달러에
                체결되는 별도 가상 사례입니다.
              </Body>
              <LessonAction
                id="auction-us-close"
                label="16:00 ET · 마감 경매 체결 보기"
                disabled={usClose}
                onPress={() => setUsClose(true)}
              />
            </>
          ) : null}
          {usClose ? (
            <>
              <Result
                title="미국 정규장 마지막 캔들"
                id="auction-us-close-result"
              >
                <CandleSeries
                  id="auction-us-close-candle"
                  domain={priceDomain([101.8, 102.2])}
                  formatPrice={(n) => `${n.toLocaleString('ko-KR')}달러`}
                  items={[
                    {
                      label: '마지막 구간 · 종가 102.2달러',
                      candle: ohlcFromPrices([101.8, 102.2]),
                    },
                  ]}
                />
                <Body>
                  시장마다 개장·마감에 가격을 결정하는 제도가 있습니다. 거래소별
                  세부 규칙을 같은 제도로 일반화하지 않습니다.
                </Body>
              </Result>
              <Takeaways
                items={[
                  '주문 수집 중에는 새 체결이나 캔들이 생기지 않습니다.',
                  '개장 체결은 시가와 첫 캔들의 시작, 마감 체결은 정규장 종가에 연결됩니다.',
                  '장후 체결가격과 확정된 정규장 종가는 구분합니다.',
                  '한국과 미국의 개장·마감 제도에는 공통 목적과 서로 다른 세부 규칙이 있습니다.',
                ]}
              />
            </>
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
  const regular = sessionOhlc(sessionTrades, false).candle;
  return (
    <>
      <Basis>한국 KRX · 미국 NYSE Arca 구간의 가상 기록 · 기업행동 없음</Basis>
      <Section title="실습 A · 갭" id="gaps-a">
        <Body>
          갭(Gap)은 이전 거래 구간의 마지막 가격과 다음 거래 구간의 시작 가격
          사이에 차이가 생기는 현상입니다. 위로 시작하면 갭 상승, 아래로
          시작하면 갭 하락입니다.
        </Body>
        <Body>
          다음 거래일 개장을 눌러 두 시장의 전일 캔들 옆에 새 시가가 만들어지는
          모습을 확인하세요.
        </Body>
        <LessonAction
          id="gap-open"
          label="한국·미국 다음 거래일 개장 진행"
          disabled={opened}
          onPress={() => setOpened(true)}
        />
        {marketExamples.map((market) => {
          const prior = market.trades[0].price;
          const next = sessionOhlc(market.trades, false).candle.open;
          return (
            <CandleSeries
              key={market.id}
              id={`gap-${market.id}-candles`}
              timeline
              domain={priceDomain([prior, next])}
              formatPrice={(n) =>
                `${n.toLocaleString('ko-KR')}${market.currency}`
              }
              items={[
                {
                  label: `${market.name} · 전 거래일 마지막 캔들`,
                  candle: ohlcFromPrices([prior]),
                },
                { label: '정규장 거래 공백', candle: null },
                {
                  label: '다음 정규장 첫 체결로 시작한 캔들',
                  candle: opened ? ohlcFromPrices([next]) : null,
                },
              ]}
            />
          );
        })}
        {opened ? (
          <Result title="두 시장의 갭 결과" id="gap-result">
            <Values
              rows={marketExamples.map((market) => {
                const prior = market.trades[0].price;
                const next = sessionOhlc(market.trades, false).candle.open;
                return [
                  market.name,
                  `${prior.toLocaleString('ko-KR')}${market.currency} → ${next.toLocaleString('ko-KR')}${market.currency} · 갭 상승 ${percent(changeRate(prior, next))}`,
                ];
              })}
            />
            <Body>
              정규장이 끝나면 거래 공백이 존재하고 그 사이에도 새로운 정보와
              주문 의사는 바뀔 수 있습니다. 다음 거래가 이전 종가와 다른
              가격에서 시작하면 갭이 보입니다. 정규장 차트의 공백은
              장전·장후까지 거래가 없었다는 뜻은 아닙니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {opened ? (
        <Section title="실습 B · 음봉인데 전일 대비 상승" id="gaps-b">
          <Body>
            시가는 구간의 첫 체결가격, 종가는 마지막 체결가격입니다. 전일 종가는
            이전 거래일의 마지막 정규장 가격입니다. 등락률은 비교 기준가격에
            대한 변화율입니다.
          </Body>
          <Body>
            당일 종가를 확인하고 ‘시가와 비교한 방향’과 ‘전일 종가와 비교한
            등락률’을 따로 읽어보세요.
          </Body>
          <LessonAction
            id="gap-close"
            label="당일 종가 확인"
            disabled={closed}
            onPress={() => setClosed(true)}
          />
          {closed ? (
            <Result
              title="음봉과 +6%가 함께 나타나는 이유"
              id="gap-close-result"
            >
              {marketExamples.map((market) => (
                <CandleSeries
                  key={market.id}
                  id={market.id === 'kr' ? 'gap-candle' : 'gap-us-candle'}
                  domain={priceDomain(market.trades.map((r) => r.price))}
                  formatPrice={(n) =>
                    `${n.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${market.currency}`
                  }
                  items={[
                    {
                      label: `${market.name} · 당일 정규장`,
                      candle: sessionOhlc(market.trades, false).candle,
                    },
                  ]}
                />
              ))}
              <Values
                rows={[
                  ['시가 / 종가 / 전일 종가', '10,700원 / 10,600원 / 10,000원'],
                  [
                    '캔들 방향',
                    regular.close < regular.open
                      ? '음봉 · 종가 < 시가'
                      : '양봉 · 종가 > 시가',
                  ],
                  [
                    '전일 대비 등락률',
                    `(${regular.close.toLocaleString('ko-KR')} ÷ 10,000 - 1) × 100 = ${percent(changeRate(10000, regular.close))}`,
                  ],
                ]}
              />
              <Body>
                갭 상승 후 시가보다 낮게 마감해도 전일 종가보다 높을 수
                있습니다. 캔들 색은 시가·종가의 관계를 나타냅니다. 이 앱은 양봉
                녹색, 음봉 빨간색이며 색만으로 전일 대비 상승·하락을 판단하지
                않습니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {closed ? (
        <Section title="실습 C · 정규장 캔들과 시간외 포함 캔들" id="gaps-c">
          <Body>
            두 시장 각각의 동일한 원본 가격 기록에서 포함 세션을 바꿔 하루의
            시가·고가·저가·종가를 다시 계산합니다. 선택 후 캔들 모양과 원본 체결
            목록을 함께 확인하세요.
          </Body>
          <Choices
            id="gap-scope"
            options={[
              { value: 'regular', label: '정규장만' },
              { value: 'extended', label: '시간외 포함' },
            ]}
            value={extended ? 'extended' : 'regular'}
            onChange={(value) => {
              setExtended(value === 'extended');
              setViewed(true);
            }}
          />
          {marketExamples.map((market) => {
            const display = sessionOhlc(market.trades, extended);
            const format = (n: number) =>
              `${n.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${market.currency}`;
            return (
              <Section key={market.id} title={market.name}>
                <CandleSeries
                  id={
                    market.id === 'kr'
                      ? 'gap-scope-candle'
                      : 'gap-us-scope-candle'
                  }
                  domain={priceDomain(market.trades.map((r) => r.price))}
                  formatPrice={format}
                  items={[
                    {
                      label: extended
                        ? '시간외 포함 자체 집계 · 공식 정규장 OHLC와 구분'
                        : '정규장 OHLC',
                      candle: display.candle,
                    },
                  ]}
                />
                <Values
                  rows={display.records.map((record) => [
                    `${record.time} ${market.zone} · ${record.session === 'regular' ? '정규장' : record.session === 'pre' ? '장전' : '장후'}`,
                    format(record.price),
                  ])}
                />
              </Section>
            );
          })}
          {viewed ? (
            <>
              <Result title="표시 범위 해석" id="gap-scope-result">
                <Body>
                  같은 종목이라도 시장·거래 세션·차트 데이터 범위가 다르면 캔들
                  모양이 달라집니다. 범위 전환은 앞서 완료한 갭·음봉 결과를
                  바꾸지 않습니다.
                </Body>
              </Result>
              <Takeaways
                items={[
                  '갭은 이전 구간의 마지막 가격과 다음 구간의 시작 가격 차이입니다.',
                  '캔들 방향은 시가와 종가, 전일 대비 등락률은 전일 종가와 비교합니다.',
                  '같은 원본도 포함 세션에 따라 다른 OHLC가 만들어집니다.',
                ]}
              />
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
