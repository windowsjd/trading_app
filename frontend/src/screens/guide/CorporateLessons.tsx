import React, { useState } from 'react';
import { View } from 'react-native';
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
  payoutRatio,
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
    <>
      <View
        style={{ flexDirection: 'row', height: 24 }}
        accessible
        accessibilityLabel={`관련 총 가치 ${won(values.total)}. 주식 ${won(values.stock)}, 받을 배당금 ${won(values.receivable)}, 지급 현금 ${won(values.cash)}`}
      >
        <View style={{ flex: values.stock, backgroundColor: '#245b76' }} />
        {values.receivable > 0 ? (
          <View
            style={{ flex: values.receivable, backgroundColor: '#995b16' }}
          />
        ) : null}
        {values.cash > 0 ? (
          <View style={{ flex: values.cash, backgroundColor: '#16a34a' }} />
        ) : null}
      </View>
      <Basis>
        막대의 전체 길이는 100,000원입니다. 아래 금액으로 각 구성요소를
        확인하세요.
      </Basis>
      <Values
        rows={[
          ['주가', won(values.price)],
          ['보유수량', `${values.quantity}주`],
          ['주식 평가액', won(values.stock)],
          [
            stage === 'before' ? '예정 배당금 · 아직 지급 전' : '받을 배당금',
            won(stage === 'before' ? 500 * values.quantity : values.receivable),
          ],
          [
            stage === 'before'
              ? '배당 지급 전 현재 보유 현금'
              : '현재 지급된 배당 현금',
            won(values.cash),
          ],
          [
            '관련 총 가치',
            stage === 'before'
              ? `${won(values.total)} + 배당 권리 정보 (예정액 별도 합산 안 함)`
              : won(values.total),
          ],
        ]}
      />
    </>
  );
}
export function DividendsLesson() {
  const [held, setHeld] = useState(false);
  const [ex, setEx] = useState(false);
  const [paid, setPaid] = useState(false);
  const [dividends, setDividends] = useState<number | null>(null);
  const netIncome = 100;
  return (
    <>
      <Section title="배당을 이해하는 세 가지 용어" id="dividend-terms">
        <Body>
          배당(Dividend)은 기업이 벌어들인 이익이나 보유 자금의 일부를 주주에게
          분배하는 것입니다. 현금배당과 주식배당 등이 있으며 이번 실습은
          현금배당만 다룹니다.
        </Body>
        <Body>
          배당락(Ex-Dividend)은 해당 배당을 받을 권리가 분리되는 시점입니다.
          일반적인 현금배당에서는 배당락일에 새로 매수한 투자자는 이번 배당
          권리를 갖지 못합니다. 정확한 기준은 해당 시장의 규정과 공시를
          따릅니다.
        </Body>
        <Body>
          배당성향(Payout Ratio)은 기업의 이익 중 배당으로 지급한 비율입니다. 총
          배당금 ÷ 당기순이익 × 100으로 계산합니다. 당기순이익 100억원 중
          30억원을 배당하면 30%입니다.
        </Body>
        <Body>
          배당성향은 주가에 대한 주당 배당금의 비율인 배당수익률과 다릅니다.
          이익·배당정책·성장투자·재무상황을 함께 보는 지표입니다.
        </Body>
      </Section>
      <Section title="1. 배당락 전" id="dividend-before">
        <Basis>별도의 원화 이론 예제 · 세금·비용·다른 시장 요인 제외</Basis>
        <Body>
          가상 기업의 주가 10,000원, 보유 10주, 결정된 현금배당은 주당
          500원입니다. 배당 발표만으로 현금이 지급되지는 않습니다. 배당락일
          전부터 보유한 상태를 확인하세요.
        </Body>
        <DividendBalance stage="before" />
        <LessonAction
          id="dividend-hold"
          label="배당락일 전 보유 확인"
          disabled={held}
          onPress={() => setHeld(true)}
        />
        {held ? (
          <Result title="배당 권리 확인" id="dividend-eligibility">
            <Body>
              {eligibleDividend('2026-03-13', dividendNotice.exDate)
                ? '이번 배당을 받을 권리가 있습니다.'
                : '이번 배당을 받을 권리가 없습니다.'}{' '}
              예정 배당금 5,000원은 아직 현금 0원에 더하지 않습니다.
            </Body>
            <Basis>
              날짜 기준을 이해하는 별도의 미국 일반 현금배당 예시 · SEC 자료
            </Basis>
            <Values
              rows={[
                ['배당락 전 매수 예', '2026-03-13 (금) · 권리 있음'],
                [
                  '배당락일 / 기준일',
                  `${dividendNotice.exDate} / ${dividendNotice.recordDate}`,
                ],
                ['이후 지급일', dividendNotice.paymentDate],
              ]}
            />
            <Body>
              이 미국 T+1 예시에서는 3월 16일 배당락일 전 매수에 권리가 있고,
              당일 새로 매수하면 없습니다. 한국은 일반적으로 T+2 결제이므로
              공시된 기준일과 거래소 영업일에 맞춰 결제가 완료되어야 합니다.
              ‘기준일 하루 전 매수’를 모든 시장에 적용하지 않습니다. 특별배당
              등은 별도 기준을 확인합니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {held ? (
        <Section title="2. 배당락 후" id="dividend-after">
          <Body>
            배당락 이후로 진행해 주식 평가액과 배당 권리의 변화를 비교하세요.
            여기서는 배당 이외의 가격 요인을 제외합니다.
          </Body>
          <LessonAction
            id="dividend-ex"
            label="배당락 이후로 진행"
            disabled={ex}
            onPress={() => setEx(true)}
          />
          {ex ? (
            <>
              <Result
                title="배당락 후 · 아직 현금 지급 전"
                id="dividend-ex-result"
              >
                <DividendBalance stage="ex" />
                <Body>
                  주당 500원 배당에 따라 이론적 주가는 10,000원 → 9,500원입니다.
                  주식 95,000원과 받을 배당금 5,000원을 합하면 100,000원입니다.
                  기업 가치 일부가 주주에게 이전되는 과정이므로 자산이 즉시
                  5,000원 늘어난 것은 아닙니다.
                </Body>
                <Body>
                  실제 배당락일 가격에는 시장 수급·새로운 정보·전체 시장
                  움직임도 반영됩니다. 정확히 배당금만큼 하락한다고 보장되지
                  않습니다. 이론적 조정은 KRX의 실제 현금배당 기준가격 처리와
                  구분합니다.
                </Body>
              </Result>
              <Section
                title="이어서 · 이후 지급일의 현금 이동"
                id="dividend-payment"
              >
                <Body>
                  배당락일은 현금 지급일이 아닙니다. 아래에서 이후 지급일을
                  확인하면 받을 배당금이 현금으로 이동합니다.
                </Body>
                <LessonAction
                  id="dividend-pay"
                  label="배당 지급일 확인"
                  disabled={paid}
                  onPress={() => setPaid(true)}
                />
                {paid ? (
                  <Result title="지급일 확인 결과" id="dividend-paid-result">
                    <DividendBalance stage="paid" />
                    <Body>
                      받을 배당금 5,000원 → 0원, 지급 현금 0원 → 5,000원. 주식
                      평가액 95,000원은 그대로이고 관련 총 가치도
                      100,000원입니다. 같은 배당을 권리와 현금으로 중복 합산하지
                      않습니다.
                    </Body>
                  </Result>
                ) : null}
              </Section>
            </>
          ) : null}
          {paid ? (
            <Section title="결과 아래에서 · 배당성향 계산" id="dividend-payout">
              <Body>
                기업 전체의 당기순이익은 100억원입니다. 총 배당금을 선택하고
                이익 중 배당한 비율을 확인하세요. 앞선 개인의 5,000원 배당금과는
                계산 대상이 다릅니다.
              </Body>
              <Choices<number>
                id="payout"
                options={[20, 30, 50].map((value) => ({
                  value,
                  label: `총 배당금 ${value}억원`,
                }))}
                value={dividends}
                onChange={setDividends}
              />
              {dividends !== null ? (
                <>
                  <Result title="배당성향 결과" id="payout-result">
                    <Values
                      rows={[
                        ['당기순이익', `${netIncome}억원`],
                        ['총 배당금', `${dividends}억원`],
                        [
                          '배당성향',
                          `${dividends} ÷ ${netIncome} × 100 = ${payoutRatio(dividends, netIncome)}%`,
                        ],
                      ]}
                    />
                    <Body>
                      이익 중 얼마나 배당했는지 나타내는 비율입니다. 높고
                      낮음만으로 좋은 기업인지 판단할 수 없으며
                      이익·배당정책·성장투자·재무상황을 함께 봅니다.
                    </Body>
                  </Result>
                  <Takeaways
                    items={[
                      '배당은 기업의 이익이나 보유 자금 일부의 분배입니다.',
                      '배당락 후 권리 보유와 이후 지급일의 현금 지급을 구분합니다.',
                      '주식 평가액·받을 배당금·지급 현금을 중복 합산하지 않습니다.',
                      '배당성향은 총 배당금 ÷ 당기순이익 × 100이며 배당수익률과 다릅니다.',
                    ]}
                  />
                </>
              ) : null}
            </Section>
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
