import React, { useState } from 'react';
import { Body, LessonAction, Result, Section, Takeaways } from './LessonUi';
import { Basis, CandleSeries, Choices, Values } from './MarketLessonUi';
import {
  dividendCandles,
  dividendNotice,
  splitCandles,
} from './marketLessonData';
import {
  adjustOhlc,
  dividendAssets,
  eligibleDividend,
  priceDomain,
  shareConversion,
} from './marketLessonCalculations';
import { won, type Ohlc } from './lessonCalculations';

function Holding({
  price,
  quantity,
  value,
}: ReturnType<typeof shareConversion>) {
  return (
    <Values
      rows={[
        ['주당가격 · 이론적 조정', won(price)],
        ['보유수량', `${quantity}주`],
        ['보유가치', `${won(price)} × ${quantity}주 = ${won(value)}`],
      ]}
    />
  );
}
export function SplitsLesson() {
  const [split, setSplit] = useState(false);
  const [reverse, setReverse] = useState(false);
  const original = { price: 100000, quantity: 10 };
  const divided = shareConversion(original.price, original.quantity, 2);
  const combined = shareConversion(50000, 20, 0.5);
  return (
    <>
      <Basis>가상 보유 예제 · 분할·병합 자체의 기계적 효과만 비교</Basis>
      <Section title="실습 A · 1주를 2주로 분할" id="split-a">
        <Body>
          주당가격만 보지 말고 보유수량과 전체 가치를 함께 확인합니다.
        </Body>
        <Holding {...shareConversion(original.price, original.quantity, 1)} />
        <LessonAction
          id="split-apply"
          label="변경 전 1주를 변경 후 2주로 분할"
          disabled={split}
          onPress={() => setSplit(true)}
        />
        {split ? (
          <Result title="분할 결과" id="split-result">
            <Holding {...divided} />
            <Body>
              수량은 두 배, 이론적 단가는 절반이 됩니다. 분할 자체만으로{' '}
              {won(divided.value)}의 보유가치가 바뀌지는 않습니다. 평단가도 같은
              비율로 조정하면 전체 매입원가는 유지됩니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {split ? (
        <Section title="실습 B · 2주를 1주로 병합" id="split-b">
          <Body>독립된 예제로 20주 × 50,000원에서 시작합니다.</Body>
          <Holding {...shareConversion(50000, 20, 1)} />
          <LessonAction
            id="reverse-apply"
            label="변경 전 2주를 변경 후 1주로 병합"
            disabled={reverse}
            onPress={() => setReverse(true)}
          />
          {reverse ? (
            <>
              <Result title="병합 결과" id="reverse-result">
                <Holding {...combined} />
                <Body>
                  병합으로 수량은 절반, 이론적 단가는 두 배가 됩니다. 이는 이후
                  시장에서 형성되는 가격과 구분해야 합니다. 분할·병합 이후 실제
                  주가는 오르거나 내릴 수 있습니다.
                </Body>
              </Result>
              <Body>
                무상증자도 수량과 기준가격에 영향을 줄 수 있지만 주식분할과
                법적·회계적으로 같은 사건은 아닙니다.
              </Body>
              <Takeaways
                items={[
                  '분할·병합의 단가와 수량을 함께 봅니다.',
                  '기계적 조정만으로 보유가치나 전체 매입원가가 늘어나지 않습니다.',
                  '분할을 호재, 병합을 악재로 단정하는 매매 규칙은 성립하지 않습니다.',
                ]}
              />
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
function DividendBalance({ stage }: { stage: 'before' | 'ex' | 'paid' }) {
  const values = dividendAssets(stage);
  return (
    <Values
      rows={[
        [
          '주식 평가액',
          `${won(values.price)} × ${values.quantity}주 = ${won(values.stock)}`,
        ],
        ['받을 배당금', won(values.receivable)],
        ['받은 현금', won(values.cash)],
        ['합계', won(values.total)],
      ]}
    />
  );
}
export function DividendsLesson() {
  const [purchase, setPurchase] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [ex, setEx] = useState(false);
  const [paid, setPaid] = useState(false);
  return (
    <>
      <Section title="실습 A · 배당 권리와 날짜" id="dividend-a">
        <Basis>{dividendNotice.market} · 미국 T+1 일반 현금배당 예제</Basis>
        <Values
          rows={[
            ['주당 배당금', `${dividendNotice.amount}달러`],
            ['배당락일', dividendNotice.exDate],
            ['배당 기준일', dividendNotice.recordDate],
            ['지급일', dividendNotice.paymentDate],
          ]}
        />
        <Body>
          배당락일은 이번 배당 권리가 없이 거래되기 시작하는 날, 기준일은
          권리자를 확인하는 기준일, 지급일은 배당금을 지급하는 날입니다.
        </Body>
        <Choices<string>
          id="dividend-buy"
          options={[
            { value: '2026-03-13', label: '3월 13일 · 배당락 전 매수' },
            { value: '2026-03-16', label: '3월 16일 · 배당락일 매수' },
            { value: '2026-03-17', label: '3월 17일 · 배당락 후 매수' },
          ]}
          value={purchase}
          onChange={setPurchase}
          disabled={recorded}
        />
        {purchase ? (
          <Result title="배당 권리 확인" id="dividend-eligibility">
            <Body>
              {purchase} 매수:{' '}
              {eligibleDividend(purchase, dividendNotice.exDate)
                ? '이번 배당을 받을 권리가 있습니다.'
                : '이번 배당을 받을 권리가 없습니다.'}
            </Body>
            <Body>
              이 일반 현금배당 예제에서는 배당락일 전 매수 여부로 판단합니다.
              국가별 결제주기와 거래소 규칙이 다르므로 ‘기준일 하루 전 매수’라는
              공통 규칙으로 바꾸면 안 됩니다. 특별배당 등은 별도 규칙이 적용될
              수 있습니다.
            </Body>
          </Result>
        ) : null}
        <LessonAction
          id="dividend-record"
          label="선택한 매수일의 권리 결과 기록"
          disabled={!purchase || recorded}
          onPress={() => setRecorded(true)}
        />
      </Section>
      {recorded ? (
        <Section title="실습 B · 배당락과 자산 구성" id="dividend-b">
          <Basis>
            별도의 원화 이론 예제 · 배당 권리를 보유한 10주 · 세금·수수료·다른
            가격 영향 제외
          </Basis>
          <Body>
            주가 10,000원, 주당 배당 500원입니다. 권리가 분리될 때와 현금이
            지급될 때를 나누어 확인합니다.
          </Body>
          <DividendBalance stage="before" />
          <LessonAction
            id="dividend-ex"
            label="배당락 · 이론적 가격 조정 적용"
            disabled={ex}
            onPress={() => setEx(true)}
          />
          {ex ? (
            <>
              <Result title="배당락일 상태" id="dividend-ex-result">
                <DividendBalance stage="ex" />
                <Body>
                  이론적으로 주가가 배당액만큼 조정된 사례입니다. 주식 평가액에
                  받을 배당금을 더한 합계는 유지되며, 아직 현금이 입금된 것은
                  아닙니다.
                </Body>
              </Result>
              <LessonAction
                id="dividend-pay"
                label="지급일 · 받을 배당금을 현금으로 지급"
                disabled={paid}
                onPress={() => setPaid(true)}
              />
            </>
          ) : null}
          {paid ? (
            <>
              <Result title="지급일 상태" id="dividend-paid-result">
                <DividendBalance stage="paid" />
                <Body>
                  받을 배당금이 0원이 되고 받은 현금으로 이동합니다. 같은 배당을
                  두 번 합산하지 않습니다. 배당은 회사 자산 일부의 분배이므로
                  자동으로 추가 수익을 보장하지 않습니다.
                </Body>
                <Body>
                  실제 배당락일 가격은 다른 시장 요인도 반영해 배당금과 정확히
                  같은 폭으로 하락하지 않을 수 있습니다. 이 이론적 가격은 KRX의
                  실제 현금배당 기준가격 처리 규칙을 재현한 값이 아닙니다.
                </Body>
              </Result>
              <Takeaways
                items={[
                  '배당락일·기준일·지급일은 다른 의미입니다.',
                  '배당 권리와 실제 현금 지급을 구분합니다.',
                  '주식 평가액, 받을 배당금, 받은 현금의 합계를 확인합니다.',
                ]}
              />
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
const ohlcValues = (candles: Ohlc[]) =>
  candles.flatMap((candle) => [
    candle.open,
    candle.high,
    candle.low,
    candle.close,
  ]);
export function AdjustedLesson() {
  const [splitMode, setSplitMode] = useState<'raw' | 'adjusted'>('raw');
  const [recorded, setRecorded] = useState(false);
  const [dividendMode, setDividendMode] = useState<'split-only' | 'dividend'>(
    'split-only',
  );
  const [viewed, setViewed] = useState(false);
  const splitAdjusted = splitCandles.map((candle, i) =>
    i === 0 ? adjustOhlc(candle, 0.5) : { ...candle },
  );
  const factor = (dividendCandles[0].close - 500) / dividendCandles[0].close;
  const dividendAdjusted = dividendCandles.map((candle, i) =>
    i === 0 ? adjustOhlc(candle, factor) : { ...candle },
  );
  const selected = splitMode === 'raw' ? splitCandles : splitAdjusted;
  const dividendSelected =
    dividendMode === 'split-only' ? dividendCandles : dividendAdjusted;
  return (
    <>
      <Basis>교육용 가상 기록 · 원본 거래 기록과 표시 변환을 구분</Basis>
      <Section title="실습 A · 분할 전후 차트" id="adjusted-a">
        <Body>
          변경 전 1주를 변경 후 2주로 분할한 동일한 기록입니다. 표시 기준을
          바꿔보세요.
        </Body>
        <Choices<'raw' | 'adjusted'>
          id="adjust-split"
          options={[
            { value: 'raw', label: '조정하지 않은 가격' },
            { value: 'adjusted', label: '주식분할 반영' },
          ]}
          value={splitMode}
          onChange={setSplitMode}
          disabled={recorded}
        />
        <CandleSeries
          id="adjust-split-chart"
          domain={priceDomain([
            ...ohlcValues(splitCandles),
            ...ohlcValues(splitAdjusted),
          ])}
          items={selected.map((candle, i) => ({
            label: i === 0 ? '분할 전 거래일' : '분할 후 거래일',
            candle,
          }))}
        />
        <Result title="표시 기준 해석" id="adjust-split-result">
          <Body>
            {splitMode === 'raw'
              ? '조정 전 종가는 100,000원에서 50,000원으로 보입니다. 주식 단위가 바뀐 효과가 포함되어 있습니다.'
              : '분할 전 시가·고가·저가·종가 전체에 0.5를 곱해 현재 주식 단위로 비교합니다. 과거 종가의 표시값은 50,000원이 됩니다.'}
          </Body>
          <Body>
            과거 조정값이 당시 실제로 거래된 가격이라는 뜻은 아닙니다. 표시
            전환은 원본 기록이나 보유수량을 변경하지 않습니다.
          </Body>
        </Result>
        <LessonAction
          id="adjust-split-record"
          label="분할 표시 기준 기록"
          disabled={recorded}
          onPress={() => setRecorded(true)}
        />
      </Section>
      {recorded ? (
        <Section title="실습 B · 배당 반영 범위" id="adjusted-b">
          <Body>
            별도 기록의 전일 종가는 10,000원, 주당 배당은 500원입니다. 이번
            기록에는 분할이 없습니다.
          </Body>
          <Choices
            id="adjust-dividend"
            options={[
              { value: 'split-only', label: '분할만 반영 · 배당 미반영' },
              { value: 'dividend', label: '배당 비율 조정도 반영' },
            ]}
            value={dividendMode}
            onChange={(value) => {
              setDividendMode(value);
              setViewed(true);
            }}
          />
          <CandleSeries
            id="adjust-dividend-chart"
            domain={priceDomain([
              ...ohlcValues(dividendCandles),
              ...ohlcValues(dividendAdjusted),
            ])}
            items={dividendSelected.map((candle, i) => ({
              label: i === 0 ? '배당락 전 기록' : '배당락일 기록',
              candle,
            }))}
          />
          <Basis>
            교육용 역산 비율: (10,000 - 500) ÷ 10,000 = {factor}. 배당락 전 OHLC
            전체에 적용합니다. 배당 재투자나 개인별 총수익은 계산하지 않습니다.
          </Basis>
          {viewed ? (
            <>
              <Result title="배당 조정 해석" id="adjust-dividend-result">
                <Body>
                  분할 조정, 배당 반영, 총수익 계산은 구분해야 합니다.
                  공급자마다 포함하는 기업행동과 조정 방법이 다를 수 있으므로
                  자료의 정의를 확인합니다. 거래소가 정하는 그날의 기준가격과
                  과거 시계열을 변환한 조정주가도 같은 개념이 아닙니다.
                </Body>
              </Result>
              <Takeaways
                items={[
                  '원본 거래가격과 조정된 표시가격을 구분합니다.',
                  'OHLC를 같은 비율로 조정해야 가격 관계가 유지됩니다.',
                  '분할·배당 반영 범위와 데이터 공급자의 계산 정의를 확인합니다.',
                ]}
              />
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
