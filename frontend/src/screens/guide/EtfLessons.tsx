import React, { useState } from 'react';
import { View } from 'react-native';
import {
  Body,
  LessonAction,
  Result,
  Section,
  Takeaways,
  lessonStyles as s,
} from './LessonUi';
import { Basis, Choices, LessonPlot, Values } from './MarketLessonUi';
import {
  benchmarkPath,
  fundAssets,
  fundNavPath,
  stableDifferences,
  variableDifferences,
} from './marketLessonData';
import {
  usTradingSession,
  changeRate,
  differenceStats,
  indexImpact,
  nav,
  normalize,
  percent,
  premium,
  priceDomain,
} from './marketLessonCalculations';
import { won } from './lessonCalculations';

// A short vertical diagram keeps the cause and its result in reading order.
function Flow({
  id,
  steps,
}: {
  id: string;
  steps: readonly (readonly [string, string])[];
}) {
  return (
    <View testID={id} style={s.section}>
      {steps.map(([label, value], i) => (
        <View key={label} style={s.section}>
          {i > 0 ? <Body>↓</Body> : null}
          <Values rows={[[label, value]]} />
        </View>
      ))}
    </View>
  );
}
const etfTakeaways = [
  '지수는 여러 자산의 움직임을 하나의 기준 숫자로 나타냅니다.',
  'ETF는 여러 자산을 담은 펀드의 지분을 거래소에서 사고팔 수 있게 만든 상품입니다.',
  '지수와 ETF는 같은 것이 아닙니다.',
  '지수를 추종하는 ETF는 해당 지수의 움직임을 비슷하게 따라가도록 운용됩니다.',
  'ETF에는 보유자산으로 계산한 NAV와 거래소에서 형성되는 시장가격이 존재합니다.',
  'ETF를 볼 때는 가격뿐 아니라 추종대상과 구성자산을 함께 확인합니다.',
];
export function IndexLesson() {
  const [returns, setReturns] = useState([10, 0, -5]);
  const [applied, setApplied] = useState(false);
  const impact = indexImpact(fundAssets, returns);
  return (
    <>
      <Section title="지수 (Index)" id="index-definition">
        <Body>
          여러 자산의 가격 움직임을 하나의 숫자로 요약해 특정 시장이나 자산
          집단의 움직임을 나타내는 기준입니다. 지수 자체는 일반적인 개별
          주식처럼 거래소에서 한 주를 직접 사는 종목이 아닙니다.
        </Body>
        <Body>
          가상 ABC 지수는 1,000에서 시작합니다. 비중은 전체 움직임에 각 기업을
          얼마나 반영할지 나타내며 A 50%, B 30%, C 20%입니다.
        </Body>
      </Section>
      <Section title="실습 · 세 기업에서 하나의 지수로" id="index-a">
        <Body>
          A·B·C의 가격 변화를 선택하고 적용하세요. 각각의 변화에 시작 비중을
          곱한 기여도를 더하면 지수 전체의 변화가 됩니다.
        </Body>
        {fundAssets.map((asset, i) => (
          <View key={asset.name} style={s.section}>
            <Body>
              {asset.name} 기업 · 시작 비중 {impact.rows[i].weight * 100}% ·
              가격 변화 선택
            </Body>
            <Choices<number>
              id={`index-${asset.name.toLowerCase()}-return`}
              options={[-10, -5, 0, 5, 10].map((value) => ({
                value,
                label: percent(value),
              }))}
              value={returns[i]}
              disabled={applied}
              onChange={(value) =>
                setReturns((previous) =>
                  previous.map((r, j) => (i === j ? value : r)),
                )
              }
            />
          </View>
        ))}
        <LessonAction
          id="index-apply"
          label="가격 변화를 하나의 지수로 모으기"
          disabled={applied}
          onPress={() => setApplied(true)}
        />
        {applied ? (
          <>
            <Flow
              id="index-flow"
              steps={[
                [
                  'A/B/C 가격 움직임',
                  returns
                    .map(
                      (value, i) => `${fundAssets[i].name} ${percent(value)}`,
                    )
                    .join(' · '),
                ],
                [
                  '시작 비중 반영 · 각 기업의 기여도',
                  impact.rows
                    .map(
                      (row, i) =>
                        `${fundAssets[i].name}: ${row.weight * 100}% × ${percent(returns[i])} = ${row.contribution > 0 ? '+' : ''}${row.contribution}%포인트`,
                    )
                    .join('\n'),
                ],
                [
                  '하나의 기준 숫자',
                  `1,000 → ${impact.index.toLocaleString('ko-KR')}포인트`,
                ],
              ]}
            />
            <Result title="지수 변화 결과" id="index-result">
              <Values
                rows={[
                  ['합산한 지수 변화율', percent(impact.rate)],
                  [
                    '지수',
                    `1,000 → ${impact.index.toLocaleString('ko-KR')}포인트`,
                  ],
                ]}
              />
              <Body>
                기본 선택 A +10%, B 0%, C -5%는 +5%포인트 + 0%포인트 - 1%포인트
                = +4%입니다. ‘지수 1,040’은 주식 한 주의 가격이 아닙니다.
              </Body>
              <Body>
                여기서는 시작 비중으로 한 구간의 수익률을 계산했습니다. 실제
                지수마다 계산방법이 다르며 모든 지수가 동일한 가중방식을 쓰지는
                않습니다.
              </Body>
            </Result>
            <Takeaways
              items={[
                '지수는 여러 자산의 움직임을 요약한 기준 숫자입니다.',
                '종목별 움직임에 비중을 반영해 전체 움직임을 계산할 수 있습니다.',
                '다음 강의에서는 실제로 거래할 수 있는 펀드인 ETF를 알아봅니다.',
              ]}
            />
          </>
        ) : null}
      </Section>
    </>
  );
}
export function EtfLesson() {
  const [viewed, setViewed] = useState(false);
  const assets = indexImpact(fundAssets, [0, 0, 0]);
  const fund = nav(assets.initialValue, 0, 100);
  return (
    <>
      <Section title="ETF (Exchange-Traded Fund)" id="etf-definition">
        <Body>
          여러 자산을 하나의 펀드에 담고 그 펀드의 지분을 주식처럼 거래소에서
          사고팔 수 있게 만든 상품입니다. 펀드는 투자자의 돈을 모아 자산을
          보유하고 운용하는 구조입니다.
        </Body>
        <Values
          rows={[
            ['지수', '시장이나 자산집단의 움직임을 측정하는 기준 숫자'],
            ['ETF', '실제로 사고팔 수 있는 펀드 상품'],
          ]}
        />
      </Section>
      <Section title="실습 · 펀드 안의 자산과 ETF 한 주" id="etf-share">
        <Body>
          가상 펀드는 A 50%, B 30%, C 20%를 보유합니다. 전체 순자산은
          1,000,000원, 발행 ETF는 100주입니다. ETF 1주 보기를 눌러 어떤 지분을
          보유하는지 확인하세요.
        </Body>
        <LessonAction
          id="etf-unit"
          label="ETF 1주 보기"
          disabled={viewed}
          onPress={() => setViewed(true)}
        />
        <Flow
          id="etf-structure"
          steps={[
            ['펀드가 담은 주식', 'A 주식 50% · B 주식 30% · C 주식 20%'],
            [
              '하나의 ETF 펀드',
              `전체 순자산 ${won(fund.netAssets)} · 발행 ETF 100주`,
            ],
            ...(viewed
              ? [
                  [
                    'ETF 1주',
                    `${won(fund.netAssets)} ÷ 100주 = 한 주당 순자산가치 ${won(fund.perShare)}`,
                  ] as const,
                ]
              : []),
          ]}
        />
        {viewed ? (
          <>
            <Result title="ETF 한 주의 의미" id="etf-unit-result">
              <Body>
                ETF 한 주를 산다고 A/B/C 주식을 각각 한 주씩 직접 소유하는 것은
                아닙니다. ETF 투자자는 펀드의 지분을 보유합니다. 이 예제에서는
                ETF 한 주가 펀드 지분의 1/100에 해당합니다.
              </Body>
              <Body>
                지수는 측정 기준이고 ETF는 거래 가능한 펀드입니다. ETF가 무엇을
                담는지, 어떤 기준을 따라 운용되는지 먼저 확인합니다.
              </Body>
            </Result>
            <Takeaways items={etfTakeaways.slice(0, 3)} />
          </>
        ) : null}
      </Section>
    </>
  );
}
export function FollowingLesson() {
  const [applied, setApplied] = useState(false);
  const changes = [10, 0, -5];
  const initial = indexImpact(fundAssets, [0, 0, 0]);
  const result = indexImpact(fundAssets, applied ? changes : [0, 0, 0]);
  const fund = nav(result.value, 0, 100);
  return (
    <>
      <Body>
        앞선 가상 ABC 지수와 같은 비중의 주식을 담은 ETF를 비교합니다. ‘추종’은
        기준지수의 움직임을 비슷하게 반영하도록 운용한다는 뜻입니다.
      </Body>
      <Section title="실습 · 같은 구성종목 변화의 전달" id="following-a">
        <Body>
          구성종목 가격 변화 적용을 누르세요. A +10%, B 0%, C -5%가 지수와 ETF의
          자산, 한 주당 가치에 함께 반영됩니다.
        </Body>
        <Basis>
          부채·운용비용·자금 유출입 없음 · ETF 발행수량 100주 고정 · 같은 구간
          시작 비중
        </Basis>
        <LessonAction
          id="following-apply"
          label="구성종목 가격 변화 적용"
          disabled={applied}
          onPress={() => setApplied(true)}
        />
        <Flow
          id="following-flow"
          steps={[
            [
              '구성종목',
              applied
                ? 'A +10% · B 0% · C -5%'
                : 'A 50% · B 30% · C 20% · 아직 가격 변화 없음',
            ],
            ['지수', `1,000 → ${result.index.toLocaleString('ko-KR')}포인트`],
            [
              'ETF 기초자산의 가치 · 부채가 없어 순자산과 같음',
              `${won(initial.value)} → ${won(fund.netAssets)}`,
            ],
            [
              'ETF 한 주당 순자산가치',
              `${won(initial.value / 100)} → ${won(fund.perShare)}`,
            ],
          ]}
        />
        {applied ? (
          <>
            <Result title="같은 움직임, 다른 단위" id="following-result">
              <Values
                rows={[
                  ['지수 수익률', percent(result.rate)],
                  [
                    'ETF 순자산 변화율',
                    percent(changeRate(initial.value, result.value)),
                  ],
                  [
                    '100주 기준 한 주당 가치',
                    `${won(fund.netAssets)} ÷ 100주 = ${won(fund.perShare)}`,
                  ],
                ]}
              />
              <Body>
                지수 1,040포인트와 ETF 한 주당 10,400원은 같은 숫자가 될 필요가
                없습니다. 이 예제에서 둘 다 +4%인 이유는 같은 구성자산의
                움직임을 반영했기 때문입니다. 실제 ETF에는 비용과 운용 차이가
                있습니다.
              </Body>
              <Body>
                ETF는 추종하는 자산들의 움직임을 비슷하게 반영하도록 운용됩니다.
                모든 ETF가 지수추종형인 것은 아니며 운용자가 전략에 따라
                투자하는 액티브 ETF도 있습니다.
              </Body>
              <Body>
                이 한 주당 순자산가치를 NAV라고 부릅니다. 다음 강의에서 자산으로
                계산한 가치와 거래소의 시장가격을 구분합니다.
              </Body>
            </Result>
            <Takeaways items={etfTakeaways.slice(2, 4)} />
          </>
        ) : null}
      </Section>
    </>
  );
}
export function NavLesson() {
  const [calculated, setCalculated] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [timing, setTiming] = useState<'same' | 'stale' | null>(null);
  const result = nav(1000000, 0, 100);
  const gap = price === null ? null : premium(price, result.perShare);
  return (
    <>
      <Section title="순자산가치와 시장가격" id="nav-definition">
        <Body>
          순자산가치(NAV, Net Asset Value)는 ETF가 보유한 자산에서 부채를 뺀
          순자산 가치입니다. 1주당 NAV는 ETF 순자산 ÷ ETF 발행주식수로
          계산합니다.
        </Body>
        <Body>
          시장가격은 실제 거래소에서 ETF 매수자와 매도자가 거래해 형성되는
          가격입니다. 자산으로 계산한 NAV와 항상 같지는 않습니다.
        </Body>
      </Section>
      <Section title="실습 A · 한 주당 가치 계산" id="nav-a">
        <Body>
          순자산 1,000,000원과 발행 ETF 100주를 나눠 한 주당 NAV를 확인하세요.
        </Body>
        <LessonAction
          id="nav-calculate"
          label="1주당 NAV 계산"
          disabled={calculated}
          onPress={() => setCalculated(true)}
        />
        {calculated ? (
          <Result title="NAV 계산 결과" id="nav-result">
            <Flow
              id="nav-calculation"
              steps={[
                ['ETF 순자산', won(result.netAssets)],
                ['ETF 발행수량', '100주'],
                [
                  '1주당 NAV',
                  `${won(result.netAssets)} ÷ 100주 = ${won(result.perShare)}`,
                ],
              ]}
            />
            <Body>전체 펀드의 순자산과 한 주당 NAV를 구분해서 읽습니다.</Body>
          </Result>
        ) : null}
      </Section>
      {calculated ? (
        <Section title="실습 B · 시장가격과 NAV 비교" id="nav-b">
          <Body>
            괴리율은 ETF 시장가격과 NAV 사이의 차이를 비율로 나타낸 값입니다.
            (시장가격 - NAV) ÷ NAV × 100으로 계산합니다.
          </Body>
          <Body>
            1주당 NAV를 10,000원으로 고정하고 시장가격을 선택하세요. 같은 시점의
            가상 평가라고 가정합니다.
          </Body>
          <Choices<number>
            id="nav-price"
            options={[9800, 10000, 10200].map((value) => ({
              value,
              label: won(value),
            }))}
            value={price}
            disabled={recorded}
            onChange={setPrice}
          />
          {gap !== null ? (
            <Result title="시장가격 차이의 결과" id="nav-premium-result">
              <Values
                rows={[
                  ['시장가격', won(price)],
                  ['1주당 NAV', won(result.perShare)],
                  [
                    '괴리율',
                    `${percent(gap)} · ${gap > 0 ? `NAV보다 ${Math.abs(gap)}% 높은 가격 · 할증` : gap < 0 ? `NAV보다 ${Math.abs(gap)}% 낮은 가격 · 할인` : 'NAV와 동일'}`,
                  ],
                  [
                    '계산',
                    `(${won(price)} - ${won(result.perShare)}) ÷ ${won(result.perShare)} × 100`,
                  ],
                ]}
              />
              <Body>
                할인은 NAV보다 낮은 가격, 할증은 높은 가격이라는 뜻입니다.
                NAV보다 싸다고 반드시 좋은 매수기회나 저평가라고 판단할 수는
                없습니다.
              </Body>
            </Result>
          ) : null}
          <LessonAction
            id="nav-record"
            label="선택한 비교 결과 기록"
            disabled={gap === null || recorded}
            onPress={() => setRecorded(true)}
          />
        </Section>
      ) : null}
      {recorded ? (
        <Section title="이어서 · 평가 기준시각" id="nav-c">
          <Body>
            NAV 기준시점과 시장가격 시점은 다를 수 있습니다. 같은 시점의 평가와
            이전 NAV를 비교해보세요.
          </Body>
          <Choices<'same' | 'stale'>
            id="nav-timing"
            options={[
              { value: 'same', label: '동일시점 가상 평가' },
              { value: 'stale', label: '이전 NAV' },
            ]}
            value={timing}
            onChange={setTiming}
          />
          {timing ? (
            <Result title="기준시각 비교" id="nav-timing-result">
              <Values
                rows={[
                  ['시장가격', '10,200원 · 2026-07-08 10:00 KST'],
                  [
                    '1주당 NAV',
                    `10,000원 · ${timing === 'same' ? '2026-07-08 10:00 KST · 동일시점 가상 평가' : `${usTradingSession('2026-07-07').closeEt} ET = ${usTradingSession('2026-07-07').closeKst} KST · 이전 NAV`}`,
                  ],
                ]}
              />
              <Body>
                {timing === 'stale'
                  ? '계산상 +2%여도 이전 평가값과의 비교입니다. 같은 시점에 확정한 가치와의 차이라고 단정할 수 없습니다.'
                  : '원리를 이해하기 위한 동시점 가정입니다. 실제 공표 NAV가 항상 실시간 값이라는 뜻은 아닙니다.'}
              </Body>
              <Body>
                평가 기준시각과 통화, 자료의 정의를 함께 확인합니다. NAV는 그
                가격에 바로 체결할 수 있다는 보장도 아닙니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

const productInfo = [
  {
    id: 'assets',
    title: '투자대상',
    value: '가상 주식 A·B·C',
    meaning:
      '어떤 자산과 시장에 투자하는지 확인합니다. ETF라는 이름만으로 원금보장이나 충분한 분산이 보장되지는 않습니다.',
  },
  {
    id: 'benchmark',
    title: '추종지수',
    value: '가상 ABC 지수',
    meaning:
      '지수의 구성과 산출 방법, 가격수익·총수익 등 비교 기준을 확인합니다. 액티브 ETF는 운용 방식이 다를 수 있습니다.',
  },
  {
    id: 'weights',
    title: '주요 구성종목과 비중',
    value: 'A 50% · B 30% · C 20% (구간 시작)',
    meaning:
      '상위 종목과 비중을 보면 특정 기업·업종에 얼마나 집중되어 있는지 알 수 있습니다.',
  },
  {
    id: 'costs',
    title: '운용비용',
    value: '교육 예제 연 0.2% · 별도 거래비용은 제외',
    meaning:
      '보수와 기타 비용은 펀드 자산과 수익률에 영향을 줍니다. 운용보수 하나만으로 지수와의 모든 차이를 설명할 수는 없습니다.',
  },
  {
    id: 'distribution',
    title: '분배금 정책',
    value: '가상 연 1회 분배 · 금액 변동 가능',
    meaning:
      '분배 시기·재원·기준일·지급일을 확인합니다. 분배금이 고정되거나 추가 수익을 보장하는 것은 아닙니다.',
  },
  {
    id: 'nav',
    title: 'NAV',
    value: '1주당 NAV 10,000원 · 2026-07-07 16:00 ET 평가',
    meaning:
      '보유자산과 부채에서 계산한 가치입니다. 통화와 기준시점, 평가 방식을 확인합니다.',
  },
  {
    id: 'price',
    title: '시장가격',
    value: '10,200원 · 2026-07-08 10:00 KST 체결',
    meaning:
      '거래소에서 형성된 가격입니다. 이 카드의 NAV와는 기준시점이 다르므로 현재 확정 가치와의 차이로 단정하지 않습니다.',
  },
];
export function TrackingLesson() {
  const [compared, setCompared] = useState(false);
  const [stable, setStable] = useState(false);
  const [variable, setVariable] = useState(false);
  const [opened, setOpened] = useState<string[]>([]);
  const indexReturn = changeRate(benchmarkPath[0], benchmarkPath.at(-1));
  const etfReturn = changeRate(fundNavPath[0], fundNavPath.at(-1));
  const trackingDifference = etfReturn - indexReturn;
  const a = differenceStats(stableDifferences);
  const b = differenceStats(variableDifferences);
  const labels = ['시작', '구간 1', '구간 2', '종료'];
  const differenceLabels = ['구간 1', '구간 2', '구간 3', '구간 4'];
  const comparisonDomain = priceDomain([
    ...normalize(benchmarkPath),
    ...normalize(fundNavPath),
  ]);
  const differenceDomain = priceDomain([
    ...stableDifferences,
    ...variableDifferences,
  ]);
  return (
    <>
      <Basis>가상 지수추종 ETF · 동일 기간·원화 기준·분배금 없는 구간</Basis>
      <Body>
        추적차이는 같은 기간 ETF 수익률에서 추종지수 수익률을 뺀 값입니다.
        추적오차는 그 수익률 차이가 시간에 따라 얼마나 들쑥날쑥한지를
        나타냅니다. 아래에서 두 개념을 차례로 비교합니다.
      </Body>
      <Section title="실습 A · 같은 기간 수익률" id="tracking-a">
        <Body>
          기준지수 1,000→1,100과 ETF NAV 10,000원→10,980원을 시작값 100으로
          맞춥니다. 예제 차이는 운용비용·현금 보유·편입 조정 효과를 합한
          가정이며 각 원인의 비중을 추정하지 않습니다.
        </Body>
        <LessonAction
          id="tracking-compare"
          label="시작값 100으로 맞춰 수익률 비교"
          disabled={compared}
          onPress={() => setCompared(true)}
        />
        {compared ? (
          <Result title="추적차이 결과" id="tracking-result">
            <LessonPlot
              id="tracking-normalized"
              domain={comparisonDomain}
              labels={labels}
              unit=" (시작=100)"
              series={[
                { name: '기준지수', values: normalize(benchmarkPath) },
                { name: 'ETF NAV', values: normalize(fundNavPath) },
              ]}
            />
            <Values
              rows={[
                ['기준지수 수익률', percent(indexReturn)],
                ['ETF NAV 수익률', percent(etfReturn)],
                [
                  '추적차이 (ETF - 지수)',
                  `${trackingDifference.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%포인트`,
                ],
              ]}
            />
            <Body>
              추적차이는 같은 기간 ETF와 기준지수의 수익률 차이입니다.
              시장가격과 NAV를 비교하는 괴리율도, 수익률 차이의 변동성을
              나타내는 추적오차도 아닙니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {compared ? (
        <Section title="실습 B · 평균 차이와 변동성" id="tracking-b">
          <Body>
            차이가 일정한 사례를 먼저 보고, 그 아래에서 위아래로 흔들리는 사례를
            실행하세요. 숫자 하나보다 시간에 따른 선의 모양을 비교합니다.
          </Body>
          <LessonAction
            id="tracking-stable"
            label="매 구간 차이가 일정한 사례 적용"
            disabled={stable}
            onPress={() => setStable(true)}
          />
          {stable ? (
            <>
              <Result title="일정한 차이의 결과" id="tracking-stable-result">
                <LessonPlot
                  id="tracking-stable-plot"
                  domain={differenceDomain}
                  labels={differenceLabels}
                  unit="%포인트"
                  series={[
                    {
                      name: '매 구간 ETF 수익률 - 지수 수익률',
                      values: stableDifferences,
                    },
                  ]}
                />
                <Values
                  rows={[
                    ['구간 차이의 평균', `${a.mean.toFixed(2)}%포인트`],
                    ['차이의 움직임', '매 구간 일정함'],
                  ]}
                />
              </Result>
              <LessonAction
                id="tracking-variable"
                label="평균은 비슷하고 편차가 큰 사례 적용"
                disabled={variable}
                onPress={() => setVariable(true)}
              />
            </>
          ) : null}
          {variable ? (
            <Result title="편차가 큰 사례의 결과" id="tracking-variable-result">
              <LessonPlot
                id="tracking-variable-plot"
                domain={differenceDomain}
                labels={differenceLabels}
                unit="%포인트"
                series={[
                  {
                    name: '매 구간 ETF 수익률 - 지수 수익률',
                    values: variableDifferences,
                  },
                ]}
              />
              <Values
                rows={[
                  ['구간 차이의 평균', `${b.mean.toFixed(2)}%포인트`],
                  ['차이의 움직임', '위아래로 크게 변함'],
                ]}
              />
              <Body>
                두 사례는 평균 차이가 같아도 시간에 따른 흔들림이 다릅니다. 이런
                변동성을 나타내는 개념이 추적오차입니다. 한 번의 -0.2%포인트
                차이는 추적차이이며, ‘추적오차 -0.2%’라고 부르지 않습니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {variable ? (
        <Section title="실습 C · 가상 ETF 상품정보" id="tracking-c">
          <Body>각 항목을 눌러 표시된 정보와 의미를 확인하세요.</Body>
          {productInfo.slice(0, opened.length + 1).map((item) => (
            <View key={item.id} style={s.section}>
              <LessonAction
                id={`product-${item.id}`}
                label={`${item.title} 확인`}
                secondary
                disabled={opened.includes(item.id)}
                onPress={() =>
                  setOpened((items) =>
                    items.includes(item.id) ? items : [...items, item.id],
                  )
                }
              />
              {opened.includes(item.id) ? (
                <Result title={item.title} id={`product-${item.id}-result`}>
                  <Body>{item.value}</Body>
                  <Body>{item.meaning}</Body>
                </Result>
              ) : null}
            </View>
          ))}
          {opened.length === productInfo.length ? (
            <Takeaways items={etfTakeaways} />
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
