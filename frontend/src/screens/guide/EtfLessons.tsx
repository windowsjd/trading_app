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

export function IndexLesson() {
  const [a, setA] = useState(10);
  const [c, setC] = useState(-5);
  const [applied, setApplied] = useState(false);
  const [fund, setFund] = useState(false);
  const impact = indexImpact(fundAssets, [a, 0, c]);
  const shares = 100;
  const initialNav = nav(impact.initialValue, 0, shares);
  const finalNav = nav(impact.value, 0, shares);
  return (
    <>
      <Basis>
        일반적인 주식형 지수추종 ETF 중심 · 가상 지수와 펀드 · 액티브 ETF도 존재
      </Basis>
      <Section title="실습 A · 구성종목의 기여도" id="index-a">
        <Body>
          처음 지수는 1,000포인트, 구간 시작 비중은 A 50%, B 30%, C 20%입니다.
          A와 C의 가격 변화를 선택하고 적용합니다. B는 0%로 고정합니다.
        </Body>
        <Values
          rows={fundAssets.map(
            (asset, i) =>
              [
                `${asset.name} · 시작 비중 ${percent(impact.rows[i].weight * 100)}`,
                `${won(asset.price)} × ${asset.quantity}주 = ${won(asset.price * asset.quantity)}`,
              ] as const,
          )}
        />
        <Body>A 가격 변화</Body>
        <Choices<number>
          id="index-a-return"
          options={[0, 10, -10].map((value) => ({
            value,
            label: percent(value),
          }))}
          value={a}
          onChange={setA}
          disabled={applied}
        />
        <Body>C 가격 변화</Body>
        <Choices<number>
          id="index-c-return"
          options={[-5, 0, 5].map((value) => ({
            value,
            label: percent(value),
          }))}
          value={c}
          onChange={setC}
          disabled={applied}
        />
        <LessonAction
          id="index-apply"
          label="구성종목 가격 변화 적용"
          disabled={applied}
          onPress={() => setApplied(true)}
        />
        {applied ? (
          <Result title="지수 변화 결과" id="index-result">
            <Values
              rows={impact.rows.map(
                (row, i) =>
                  [
                    `${fundAssets[i].name} 기여도`,
                    `${percent(row.weight * 100)} × ${percent([a, 0, c][i])} = ${row.contribution.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%포인트`,
                  ] as const,
              )}
            />
            <Values
              rows={[
                [
                  '비중 합계',
                  percent(
                    impact.rows.reduce((sum, row) => sum + row.weight, 0) * 100,
                  ),
                ],
                ['이 구간 지수 수익률', percent(impact.rate)],
                [
                  '지수',
                  `1,000 → ${impact.index.toLocaleString('ko-KR')}포인트`,
                ],
              ]}
            />
            <Body>
              시작 비중으로 종목별 수익률을 가중한 한 구간 계산입니다. 모든
              지수가 같은 가중방식을 사용하는 것은 아니며 실제
              리밸런싱·유동주식수·제수 규칙을 모두 재현하지 않습니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {applied ? (
        <Section title="실습 B · 지수와 펀드 지분" id="index-b">
          <Body>
            같은 구성자산을 가진 가상 ETF에 앞선 가격 변화를 적용합니다.
            발행수량은 100주, 부채는 0원이며 자금 유입·유출과 비용은 없다고
            가정합니다.
          </Body>
          <Values
            rows={[
              ['최초 순자산', won(initialNav.netAssets)],
              ['최초 1주당 NAV', won(initialNav.perShare)],
            ]}
          />
          <LessonAction
            id="index-fund"
            label="구성자산 변화로 ETF 가치 계산"
            disabled={fund}
            onPress={() => setFund(true)}
          />
          {fund ? (
            <>
              <Result title="ETF 평가 결과" id="index-fund-result">
                <Values
                  rows={impact.rows.map(
                    (row, i) =>
                      [
                        `${fundAssets[i].name} 평가액`,
                        `${won(row.nextPrice)} × ${row.quantity}주 = ${won(row.value)}`,
                      ] as const,
                  )}
                />
                <Values
                  rows={[
                    ['순자산', won(finalNav.netAssets)],
                    ['ETF 발행수량', `${shares}주`],
                    [
                      '1주당 NAV',
                      `${won(finalNav.netAssets)} ÷ ${shares}주 = ${won(finalNav.perShare)}`,
                    ],
                    ['지수', `${impact.index.toLocaleString('ko-KR')}포인트`],
                  ]}
                />
                <Body>
                  지수는 시장 움직임을 측정하는 기준이고 ETF는 거래소에서
                  거래되는 펀드 지분입니다. 포인트와 원화 가격은 단위와 기준이
                  달라 절대 숫자가 같을 필요가 없습니다. ETF 한 주 매수는
                  구성종목을 한 주씩 직접 소유하는 것과 다릅니다.
                </Body>
              </Result>
              <Takeaways
                items={[
                  '시작 비중과 종목별 가격 변화가 지수 기여도를 결정합니다.',
                  'ETF는 구성자산을 보유하는 펀드의 지분입니다.',
                  '지수 포인트와 ETF의 1주당 가치를 구분합니다.',
                ]}
              />
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

export function NavLesson() {
  const [liabilities, setLiabilities] = useState(50000);
  const [calculated, setCalculated] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [timing, setTiming] = useState<'same' | 'stale' | null>(null);
  const result = nav(1050000, liabilities, 100);
  const gap = price === null ? null : premium(price, 10000);
  return (
    <>
      <Basis>가상 ETF · 전체 순자산과 1주당 순자산가치를 구분</Basis>
      <Section title="실습 A · NAV 계산" id="nav-a">
        <Body>
          자산 평가액 1,050,000원, 발행수량 100주인 펀드에서 부채를 선택합니다.
        </Body>
        <Choices<number>
          id="nav-liabilities"
          options={[0, 50000, 100000].map((value) => ({
            value,
            label: `부채 ${won(value)}`,
          }))}
          value={liabilities}
          onChange={setLiabilities}
          disabled={calculated}
        />
        <LessonAction
          id="nav-calculate"
          label="자산·부채에서 NAV 계산"
          disabled={calculated}
          onPress={() => setCalculated(true)}
        />
        {calculated ? (
          <Result title="NAV 계산 결과" id="nav-result">
            <Values
              rows={[
                [
                  '전체 펀드 순자산',
                  `${won(1050000)} - ${won(liabilities)} = ${won(result.netAssets)}`,
                ],
                [
                  '1주당 NAV',
                  `${won(result.netAssets)} ÷ 100주 = ${won(result.perShare)}`,
                ],
              ]}
            />
            <Body>
              1주당 NAV는 자산 평가액에서 부채를 뺀 뒤 ETF 발행수량으로 나눈
              값입니다. 전체 펀드 순자산과 같은 숫자가 아닙니다.
            </Body>
          </Result>
        ) : null}
      </Section>
      {calculated ? (
        <Section title="실습 B · 시장가격과 괴리율" id="nav-b">
          <Body>
            독립된 예제로 1주당 NAV를 10,000원에 고정합니다. 같은 시점의 가상
            시장가격을 바꿔보세요.
          </Body>
          <Choices<number>
            id="nav-price"
            options={[10200, 10000, 9800].map((value) => ({
              value,
              label: won(value),
            }))}
            value={price}
            onChange={setPrice}
            disabled={recorded}
          />
          {gap !== null ? (
            <Result title="괴리율 결과" id="nav-premium-result">
              <Values
                rows={[
                  ['시장가격', won(price)],
                  ['1주당 NAV', won(10000)],
                  [
                    '괴리율',
                    `${percent(gap)} · ${gap > 0 ? '할증' : gap < 0 ? '할인' : 'NAV와 같음'}`,
                  ],
                  [
                    '계산',
                    `(${won(price)} - ${won(10000)}) ÷ ${won(10000)} × 100`,
                  ],
                ]}
              />
              <Body>
                시장가격은 호가와 체결로 형성되고 NAV는 자산과 부채의 평가에서
                나옵니다. 괴리율은 지수 포인트와의 차이가 아닙니다. 할인이라고
                해서 이익이 보장되는 것도 아닙니다.
              </Body>
            </Result>
          ) : null}
          <LessonAction
            id="nav-record"
            label="선택한 괴리율 결과 기록"
            disabled={gap === null || recorded}
            onPress={() => setRecorded(true)}
          />
        </Section>
      ) : null}
      {recorded ? (
        <Section title="실습 C · 평가 기준시각" id="nav-c">
          <Choices<'same' | 'stale'>
            id="nav-timing"
            options={[
              { value: 'same', label: '동일시점 가상 평가' },
              { value: 'stale', label: '기초자산 휴장 시간 · 이전 평가' },
            ]}
            value={timing}
            onChange={setTiming}
          />
          {timing ? (
            <Result title="기준시각 비교" id="nav-timing-result">
              <Values
                rows={[
                  ['ETF 시장가격', '10,200원 · 2026-07-08 10:00 KST'],
                  [
                    '1주당 평가값',
                    `10,000원 · ${timing === 'same' ? '2026-07-08 10:00 KST · 동일시점 가상 평가' : `${usTradingSession('2026-07-07').closeEt} ET = ${usTradingSession('2026-07-07').closeKst} KST · 이전 NAV`}`,
                  ],
                ]}
              />
              <Body>
                {timing === 'stale'
                  ? '미국 기초자산의 정규장이 닫힌 동안 이전 평가값을 비교하는 사례입니다. 계산상 +2%여도 동일시점 확정 평가와의 차이라고 단정하면 안 됩니다.'
                  : '비교 원리를 위해 같은 시점에 평가한 사례입니다. 실제 공표 NAV가 항상 이런 실시간 평가값이라는 뜻은 아닙니다.'}
              </Body>
              <Body>
                NAV에는 산출·공표 주기가 있고 장중 추정 순자산가치(iNAV)는
                추정값입니다. 표시된 NAV에 즉시 체결할 수 있다는 보장은
                없습니다.
              </Body>
              <Body>
                일반 투자자의 거래소 매매와 지정참가회사의 설정·환매는 다른
                과정입니다. ETF 한 주가 매매될 때마다 펀드가 구성종목을 즉시
                매수하는 것은 아닙니다. 설정·환매는 괴리 축소에 기여할 수 있지만
                항상 즉시 NAV로 거래되게 하지는 않습니다.
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
    id: 'asof',
    title: '시장가격과 NAV의 기준시점',
    value: '시장가격 2026-07-08 10:00 KST / NAV 2026-07-07 16:00 ET',
    meaning:
      '통화와 평가 기준시각, 지연 여부, NAV인지 iNAV인지 확인합니다. 이 사례의 두 값은 같은 시점이 아닙니다.',
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
                    [
                      '구간 차이의 표준편차',
                      `${a.deviation.toFixed(2)}%포인트`,
                    ],
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
                  ['구간 차이의 표준편차', `${b.deviation.toFixed(2)}%포인트`],
                ]}
              />
              <Basis>
                두 사례 모두 같은 길이의 4개 구간입니다. 표시값은 편차 제곱합을
                4로 나눈 모집단 표준편차이며 연율화하지 않았습니다.
              </Basis>
              <Body>
                추적오차는 기간별 수익률 차이가 얼마나 변동하는지를 나타내며
                통상 그 차이의 표준편차를 연율화합니다. 한 번의 -0.2%포인트
                차이를 ‘추적오차 -0.2%’라고 부르지 않습니다. 낮은 추적오차가
                높은 수익률을 보장하지도 않습니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {variable ? (
        <Section title="실습 C · 가상 ETF 상품정보" id="tracking-c">
          <Body>각 항목을 눌러 표시된 정보와 의미를 확인하세요.</Body>
          {productInfo.map((item) => (
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
            <Takeaways
              items={[
                '시장가격과 1주당 NAV의 차이는 괴리율입니다.',
                '같은 기간 ETF와 지수 수익률의 차이는 추적차이입니다.',
                '기간별 수익률 차이의 변동성은 추적오차와 관련됩니다.',
                '투자대상·비용·분배금·평가 기준시점까지 상품정보를 확인합니다.',
              ]}
            />
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
