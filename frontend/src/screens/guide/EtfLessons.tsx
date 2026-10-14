import React, { useState } from 'react';
import { View } from '../../theme/native';
import {
  Body,
  LessonAction,
  Result,
  Section,
  Takeaways,
  lessonStyles as s,
} from './LessonUi';
import { Basis, Choices, LessonPlot, Values } from './MarketLessonUi';
import { benchmarkPath, fundAssets, fundNavPath } from './marketLessonData';
import {
  changeRate,
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
// The virtual ABC index and the ETF that holds the same three stocks.
const start = indexImpact(fundAssets, [0, 0, 0]);
const shares = 100;
// One example move shared by the index and NAV lessons: A +10% · B 0% · C -5%.
const sample = [10, 0, -5];
const weight = (i: number) => `${start.rows[i].weight * 100}%`;
const moves = (returns: number[]) =>
  fundAssets
    .map((asset, i) => `${asset.name} ${percent(returns[i])}`)
    .join(' · ');
const indexMove = (index: number) =>
  `${start.index.toLocaleString('ko-KR')} → ${index.toLocaleString('ko-KR')}포인트`;

export function IndexLesson() {
  const [guess, setGuess] = useState<'a' | 'c' | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [applied, setApplied] = useState(false);
  const rise = 10;
  const onlyA = indexImpact(fundAssets, [rise, 0, 0]);
  const onlyC = indexImpact(fundAssets, [0, 0, rise]);
  const merged = indexImpact(fundAssets, sample);
  return (
    <>
      <Section title="지수 (Index)" id="index-definition">
        <Body>
          내 종목 하나가 아니라 시장 전체가 올랐는지 내렸는지 궁금할 때가
          있습니다. 이때 종목을 하나씩 살펴보지 않고 숫자 하나로 확인하는 것이
          지수입니다.
        </Body>
        <Body>
          여러 자산의 가격 움직임을 하나의 숫자로 요약해 특정 시장이나 자산
          집단의 움직임을 나타내는 기준입니다. 지수 자체는 일반적인 개별
          주식처럼 거래소에서 한 주를 직접 사는 종목이 아닙니다.
        </Body>
        <Body>
          {`가상 ABC 지수는 ${start.index.toLocaleString('ko-KR')}에서 시작합니다. 비중은 전체 움직임에 각 기업을 얼마나 반영할지 나타내며 A ${weight(0)}, B ${weight(1)}, C ${weight(2)}입니다.`}
        </Body>
      </Section>
      <Section title="실습 · 비중이 다른 두 기업" id="index-predict">
        <Body>
          {`A 기업만 ${percent(rise)} 오른 경우와 C 기업만 ${percent(rise)} 오른 경우, 어느 쪽이 지수를 더 올릴까요? 예측을 하나 고르세요.`}
        </Body>
        <Choices<'a' | 'c'>
          id="index-predict"
          options={[
            { value: 'a', label: `A 기업만 ${percent(rise)}` },
            { value: 'c', label: `C 기업만 ${percent(rise)}` },
          ]}
          value={guess}
          disabled={recorded}
          onChange={setGuess}
        />
        {guess ? (
          <Result title="예측 결과" id="index-predict-result">
            <Body>
              {guess === 'a'
                ? '예측이 맞았습니다. A 기업만 오른 경우가 지수를 더 크게 올립니다.'
                : 'A 기업만 오른 경우가 지수를 더 크게 올립니다. C 기업은 비중이 작아 같은 비율로 올라도 지수를 덜 움직입니다.'}
            </Body>
            <Values
              rows={[
                [
                  `A 기업만 ${percent(rise)}`,
                  `${weight(0)} × ${rise}% = ${percent(onlyA.rows[0].contribution)}포인트\n지수 ${indexMove(onlyA.index)}`,
                ],
                [
                  `C 기업만 ${percent(rise)}`,
                  `${weight(2)} × ${rise}% = ${percent(onlyC.rows[2].contribution)}포인트\n지수 ${indexMove(onlyC.index)}`,
                ],
              ]}
            />
            <Body>
              같은 비율로 움직여도 비중이 큰 종목이 지수를 더 크게 움직입니다.
            </Body>
          </Result>
        ) : null}
        <LessonAction
          id="index-predict-record"
          label="예측 기록하고 합쳐 보기"
          disabled={guess === null || recorded}
          onPress={() => setRecorded(true)}
        />
      </Section>
      {recorded ? (
        <Section title="실습 · 세 기업을 하나의 지수로" id="index-merge">
          <Body>
            이번에는 세 기업이 함께 움직입니다. 각 기업의 변화에 비중을 곱한
            기여도를 모두 더하면 지수 전체의 변화가 됩니다.
          </Body>
          <LessonAction
            id="index-apply"
            label={`${moves(sample)}를 하나의 지수로 모으기`}
            disabled={applied}
            onPress={() => setApplied(true)}
          />
          {applied ? (
            <>
              <Flow
                id="index-flow"
                steps={[
                  ['세 종목 움직임', moves(sample)],
                  [
                    '비중 × 변화 = 기여도',
                    merged.rows
                      .map(
                        (row, i) =>
                          `${fundAssets[i].name}: ${weight(i)} × ${percent(sample[i])} = ${percent(row.contribution)}포인트`,
                      )
                      .join('\n'),
                  ],
                  ['하나의 기준 숫자', indexMove(merged.index)],
                ]}
              />
              <Result title="지수 변화 결과" id="index-result">
                <Values
                  rows={[
                    ['합산 변화율', percent(merged.rate)],
                    ['지수', indexMove(merged.index)],
                  ]}
                />
                <Body>
                  {`세 기여도를 더한 ${percent(merged.rate)}가 지수의 변화율입니다. 지수 ${merged.index.toLocaleString('ko-KR')}은 주식 한 주의 가격이 아닙니다.`}
                </Body>
                <Body>
                  여기서는 시작 비중으로 한 구간의 변화를 계산했습니다. 실제
                  지수마다 계산방법이 다릅니다. 모든 지수가 같은 가중방식을
                  쓰지는 않습니다.
                </Body>
              </Result>
            </>
          ) : null}
        </Section>
      ) : null}
      {applied ? (
        <Takeaways
          items={[
            '지수는 시장 전체의 움직임을 보는 기준 숫자이고, 내가 직접 살 수 있는 종목이 아닙니다.',
            '같은 비율로 움직여도 비중이 큰 종목일수록 지수를 더 크게 움직입니다.',
            '다음 강의에서는 이 지수를 한 번에 담아 거래하는 방법인 ETF를 알아봅니다.',
          ]}
        />
      ) : null}
    </>
  );
}
export function EtfLesson() {
  const [viewed, setViewed] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const drop = -20;
  const fund = nav(start.initialValue, 0, shares);
  const invested = `${start.initialValue / 10000}만 원`;
  const alone = start.initialValue * (1 + drop / 100);
  const aloneRow = [
    `그 종목에만 ${invested}`,
    `${won(start.initialValue)} → ${won(alone)} (${percent(changeRate(start.initialValue, alone))})`,
  ] as const;
  const target = fundAssets.findIndex(
    (asset) => asset.name.toLowerCase() === pick,
  );
  const shock = indexImpact(
    fundAssets,
    fundAssets.map((_, i) => (i === target ? drop : 0)),
  );
  const market = indexImpact(
    fundAssets,
    fundAssets.map(() => drop),
  );
  return (
    <>
      <Section title="ETF (Exchange-Traded Fund)" id="etf-definition">
        <Body>
          여러 자산을 담은 펀드의 지분을 주식처럼 거래소에서 사고팔 수 있게
          만든 상품입니다. 펀드는 투자자의 돈을 모아 자산을 보유하고 운용하는
          구조입니다.
        </Body>
        <Body>
          ETF를 한 번 주문하면 A·B·C 세 기업의 주식을 함께 담는 효과가
          있습니다. 다만 ETF를 사도 담긴 주식을 각각 직접 소유하는 것은
          아닙니다.
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
          {`가상 펀드는 A ${weight(0)}, B ${weight(1)}, C ${weight(2)}를 보유합니다. 전체 순자산은 ${won(fund.netAssets)}, 발행 ETF는 ${shares}주입니다. ETF 1주 보기를 눌러 어떤 지분을 보유하는지 확인하세요.`}
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
            [
              '펀드가 담은 주식',
              fundAssets
                .map((asset, i) => `${asset.name} 주식 ${weight(i)}`)
                .join(' · '),
            ],
            [
              '하나의 ETF 펀드',
              `전체 순자산 ${won(fund.netAssets)} · 발행 ETF ${shares}주`,
            ],
            ...(viewed
              ? [
                  [
                    'ETF 1주',
                    `펀드 지분의 1/${shares} = ${won(fund.netAssets)} ÷ ${shares}주 = 한 주당 가치 ${won(fund.perShare)}`,
                  ] as const,
                ]
              : []),
          ]}
        />
        {viewed ? (
          <Result title="ETF 한 주의 의미" id="etf-unit-result">
            <Body>
              {`ETF 한 주를 산다고 A/B/C 주식을 각각 한 주씩 직접 소유하는 것은 아닙니다. ETF 투자자는 펀드의 지분을 보유합니다. 이 예제에서는 ETF 한 주가 펀드 지분의 1/${shares}에 해당합니다.`}
            </Body>
          </Result>
        ) : null}
      </Section>
      {viewed ? (
        <Section
          title={`실습 · 한 종목이 갑자기 ${percent(drop)} 내려간다면`}
          id="etf-shock"
        >
          <Body>
            {`${invested}을 (가) 그 종목 하나에만 넣었을 때와 (나) ETF에 넣었을 때를 비교합니다. 어느 기업에 사고가 날지는 미리 알 수 없습니다. ${percent(drop)} 내려갈 기업을 하나 고르세요.`}
          </Body>
          <Choices<string>
            id="etf-shock-pick"
            options={fundAssets.map((asset) => ({
              value: asset.name.toLowerCase(),
              label: `${asset.name} 기업이 ${percent(drop)}`,
            }))}
            value={pick}
            disabled={recorded}
            onChange={setPick}
          />
          {pick ? (
            <Result title="한 종목 사고의 결과" id="etf-shock-result">
              <Values
                rows={[
                  aloneRow,
                  [
                    `ETF에 ${invested}`,
                    `${won(start.initialValue)} → ${won(shock.value)} (${percent(shock.rate)})\n${fundAssets[target].name} 비중 ${weight(target)} × ${percent(drop)} = ${percent(shock.rate)}`,
                  ],
                ]}
              />
              <Body>
                여러 종목에 나눠 담으면 한 종목의 사고가 그 종목의 비중만큼
                나뉘어 전달됩니다. 이렇게 여러 자산에 나눠 담아 한 자산의
                영향을 줄이는 것을 분산이라고 합니다.
              </Body>
            </Result>
          ) : null}
          <LessonAction
            id="etf-shock-record"
            label="선택 기록하고 시장 전체 하락 보기"
            disabled={pick === null || recorded}
            onPress={() => setRecorded(true)}
          />
          {recorded ? (
            <Result
              title={`이번에는 세 종목이 모두 ${percent(drop)}`}
              id="etf-market-result"
            >
              <Values
                rows={[
                  aloneRow,
                  [
                    `ETF에 ${invested}`,
                    `${won(start.initialValue)} → ${won(market.value)} (${percent(market.rate)})`,
                  ],
                ]}
              />
              <Body>
                {`A·B·C가 모두 ${percent(drop)}이면 ETF도 ${percent(market.rate)}로, 한 종목에만 담았을 때와 같습니다. 분산은 한 종목의 사고를 줄여 줄 뿐 시장 전체의 하락을 피하게 해 주지는 않습니다. ETF는 원금이 보장되는 상품이 아닙니다.`}
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {recorded ? (
        <Takeaways
          items={[
            'ETF는 여러 자산을 담은 펀드의 지분을 주식처럼 거래하는 상품입니다.',
            'ETF를 사도 담긴 주식을 각각 직접 소유하는 것은 아닙니다.',
            '여러 종목에 나눠 담으면 한 종목의 사고는 줄지만, 시장 전체가 내리는 위험은 피할 수 없습니다.',
          ]}
        />
      ) : null}
    </>
  );
}
export function EtfPriceLesson() {
  const [applied, setApplied] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [recorded, setRecorded] = useState(false);
  const before = nav(start.initialValue, 0, shares);
  const result = indexImpact(fundAssets, sample);
  const after = nav(result.value, 0, shares);
  const gap = price === null ? null : premium(price, before.perShare);
  return (
    <>
      <Section title="순자산가치와 시장가격" id="etf-price-definition">
        <Body>
          순자산가치(NAV, Net Asset Value)는 ETF가 보유한 자산에서 부채를 뺀
          순자산 가치입니다. 1주당 NAV는 ETF 순자산 ÷ ETF 발행주식수로
          계산합니다.
        </Body>
        <Body>
          시장가격은 실제 거래소에서 ETF 매수자와 매도자가 거래해 형성되는
          가격입니다. 자산으로 계산한 NAV와 항상 같지는 않습니다. NAV를 계산한
          기준 시각과 시장가격이 정해진 시각도 다를 수 있습니다.
        </Body>
      </Section>
      <Section
        title="실습 · 바구니 값에서 ETF 한 주의 NAV까지"
        id="etf-price-follow"
      >
        <Body>
          ETF가 지수를 ‘추종’한다는 것은 기준 지수의 움직임을 비슷하게
          반영하도록 운용한다는 뜻입니다. 가상 ABC 지수와 같은 비중으로 A·B·C를
          담은 ETF에 구성종목 가격 변화를 적용해 보세요.
        </Body>
        <LessonAction
          id="etf-price-apply"
          label="구성종목 가격 변화 적용"
          disabled={applied}
          onPress={() => setApplied(true)}
        />
        {applied ? (
          <>
            <Flow
              id="etf-price-flow"
              steps={[
                ['구성종목 가격 변화', moves(sample)],
                ['지수', indexMove(result.index)],
                [
                  '바구니 · ETF 순자산',
                  `${won(before.netAssets)} → ${won(after.netAssets)}`,
                ],
                [
                  `1주당 NAV (÷${shares}주)`,
                  `${won(before.perShare)} → ${won(after.perShare)}`,
                ],
              ]}
            />
            <Result title="같은 움직임, 다른 단위" id="etf-price-result">
              <Values
                rows={[
                  ['지수 변화율', percent(result.rate)],
                  [
                    '1주당 NAV 변화율',
                    percent(changeRate(before.perShare, after.perShare)),
                  ],
                ]}
              />
              <Body>
                {`지수 ${result.index.toLocaleString('ko-KR')}포인트와 ETF 한 주 ${won(after.perShare)}은 같은 숫자가 될 필요가 없습니다. 이 예제에서 둘 다 ${percent(result.rate)}인 이유는 같은 구성자산의 움직임을 반영했기 때문입니다. 실제 ETF에는 비용과 운용 차이가 있습니다.`}
              </Body>
              <Body>
                모든 ETF가 지수추종형은 아니며, 운용자가 전략에 따라 투자하는
                액티브 ETF도 있습니다.
              </Body>
              <Basis>
                {`부채·비용·자금 유출입 없음 · 발행 ${shares}주 고정`}
              </Basis>
            </Result>
          </>
        ) : null}
      </Section>
      {applied ? (
        <Section title="실습 · 시장가격과 NAV 비교" id="etf-price-gap">
          <Body>
            {`괴리율은 ETF 시장가격이 NAV와 얼마나 차이 나는지를 비율로 나타낸 값입니다. 1주당 NAV를 ${won(before.perShare)}으로 고정하고 시장가격을 선택하세요.`}
          </Body>
          <Choices<number>
            id="etf-price-gap"
            options={[9800, 10000, 10200].map((value) => ({
              value,
              label: won(value),
            }))}
            value={price}
            disabled={recorded}
            onChange={setPrice}
          />
          {gap !== null ? (
            <Result title="시장가격 차이의 결과" id="etf-price-gap-result">
              <Values
                rows={[
                  ['시장가격', won(price)],
                  ['1주당 NAV', won(before.perShare)],
                  [
                    '괴리율',
                    `${percent(gap)} · ${gap > 0 ? `NAV보다 ${Math.abs(gap)}% 높은 가격 · 할증` : gap < 0 ? `NAV보다 ${Math.abs(gap)}% 낮은 가격 · 할인` : 'NAV와 같은 가격'}`,
                  ],
                  [
                    '계산',
                    `(시장가격 - NAV) ÷ NAV × 100\n= (${won(price)} - ${won(before.perShare)}) ÷ ${won(before.perShare)} × 100`,
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
            id="etf-price-record"
            label="선택한 비교 결과 기록"
            disabled={gap === null || recorded}
            onPress={() => setRecorded(true)}
          />
        </Section>
      ) : null}
      {recorded ? (
        <Takeaways
          items={[
            'ETF 한 주의 NAV는 담은 자산의 가치를 발행 주수로 나눈 값입니다.',
            '거래소의 시장가격은 NAV와 다를 수 있고, 그 차이는 괴리율로 봅니다.',
            '지수 포인트와 ETF 가격은 서로 다른 숫자라서 같은 값일 필요가 없습니다.',
          ]}
        />
      ) : null}
    </>
  );
}
export function EtfPickLesson() {
  const [choice, setChoice] = useState<'x' | 'y' | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [shown, setShown] = useState(false);
  const indexReturn = changeRate(benchmarkPath[0], benchmarkPath.at(-1));
  const navReturn = changeRate(fundNavPath[0], fundNavPath.at(-1));
  const domain = priceDomain([
    ...normalize(benchmarkPath),
    ...normalize(fundNavPath),
  ]);
  return (
    <>
      <Section title="고르기 전에 묻는 세 가지" id="etf-pick-intro">
        <Body>
          ETF를 고를 때는 ‘무엇을 담았나’, ‘무엇을 따라가나’, ‘얼마가 드나’ 세
          가지를 차례로 확인합니다. 가상 ETF 두 개로 하나씩 살펴봅니다.
        </Body>
      </Section>
      <Section title="실습 · 가상 ETF 두 개 비교" id="etf-pick-compare">
        <Basis>가상 ETF 두 개 · 실제 상품 아님 · 교육용 가정</Basis>
        <Values
          id="etf-pick-cards"
          rows={[
            ['ETF X', '30종목 · 여러 업종 · 비용 연 0.2%'],
            ['ETF Y', '5종목 · 한 업종 · 비용 연 0.9%'],
          ]}
        />
        <Body>
          카드에 적힌 구성만 보고 답해 보세요. 업종 분산 측면에서 더 폭넓게
          구성된 ETF는 어느 쪽일까요?
        </Body>
        <Choices<'x' | 'y'>
          id="etf-pick-spread"
          options={[
            { value: 'x', label: 'ETF X' },
            { value: 'y', label: 'ETF Y' },
          ]}
          value={choice}
          disabled={recorded}
          onChange={setChoice}
        />
        {choice ? (
          <Result title="업종 분산 비교 결과" id="etf-pick-spread-result">
            <Body>
              {choice === 'x'
                ? '판단이 맞았습니다. 여러 업종에 나눠 담은 ETF X가 업종 분산 측면에서 더 폭넓게 구성되어 있습니다.'
                : 'ETF Y가 아니라, 여러 업종에 나눠 담은 ETF X가 업종 분산 측면에서 더 폭넓게 구성되어 있습니다.'}
            </Body>
            <Body>
              여러 업종에 나눠 담으면 특정 업종에 집중된 위험을 낮출 수
              있습니다. 한 업종에만 담은 ETF Y는 그 업종의 부진에 더
              직접적으로 노출됩니다.
            </Body>
            <Body>
              다만 업종이 넓게 나뉘어 있다는 사실만으로 ETF X의 손실이 더
              작거나 가격이 덜 움직인다고 보장되지는 않습니다. 종목 수뿐 아니라
              종목별 구성 비중과, 종목들이 서로 얼마나 비슷하게
              움직이는지(상관관계)도 함께 봐야 합니다.
            </Body>
            <Body>
              이름에 ETF가 붙었다는 것만으로 원금이 보장되거나 충분히 분산되는
              것은 아닙니다.
            </Body>
          </Result>
        ) : null}
        <LessonAction
          id="etf-pick-record"
          label="선택 기록하고 비용 보기"
          disabled={choice === null || recorded}
          onPress={() => setRecorded(true)}
        />
      </Section>
      {recorded ? (
        <Section title="실습 · 비용과 지수와의 차이" id="etf-pick-cost">
          <Body>
            ETF를 운용하는 데 드는 비용은 펀드 자산에서 나갑니다. 이 비용은
            같은 지수를 따라가는 ETF의 수익률이 지수와 달라지는 원인 중
            하나입니다. 펀드가 일부를 현금으로 들고 있거나 구성종목을
            편입·조정하는 과정에서도 차이가 생길 수 있습니다.
          </Body>
          <Basis>
            가상 지수추종 ETF · 앞의 ETF X·Y와 별개의 예제 · 같은 기간·원화 기준
          </Basis>
          <LessonAction
            id="etf-pick-gap"
            label="지수와 ETF 수익률 차이 보기"
            disabled={shown}
            onPress={() => setShown(true)}
          />
          {shown ? (
            <Result title="지수와의 차이" id="etf-pick-gap-result">
              <LessonPlot
                id="etf-pick-plot"
                domain={domain}
                labels={['시작', '구간 1', '구간 2', '종료']}
                unit=" (시작=100)"
                series={[
                  { name: '지수', values: normalize(benchmarkPath) },
                  { name: 'ETF NAV', values: normalize(fundNavPath) },
                ]}
              />
              <Values
                rows={[
                  ['지수 수익률', percent(indexReturn)],
                  ['ETF NAV 수익률', percent(navReturn)],
                  [
                    '추적차이 (ETF - 지수)',
                    `${percent(navReturn - indexReturn)}포인트`,
                  ],
                ]}
              />
              <Body>
                추적차이는 같은 기간 ETF 수익률에서 지수 수익률을 뺀 값입니다. 이
                예제의 차이는 비용·현금 보유·구성종목 편입과 조정 효과를 합친
                가정이며, 원인별 비중은 추정하지 않습니다. 따라서 이 차이 전체를
                비용 때문이라고 볼 수는 없습니다.
              </Body>
            </Result>
          ) : null}
        </Section>
      ) : null}
      {shown ? (
        <>
          <Section title="ETF를 고를 때 확인할 곳">
            <Values
              id="etf-pick-checklist"
              rows={[
                ['무엇을 담았나', '구성종목·업종·비중'],
                ['무엇을 따라가나', '추종하는 지수 또는 운용 방식'],
                ['얼마가 드나', '총보수 등 비용과 지수와의 차이'],
              ]}
            />
          </Section>
          <Takeaways
            items={[
              '지수는 여러 자산의 움직임을 하나의 기준 숫자로 나타냅니다.',
              'ETF는 여러 자산을 담은 펀드의 지분을 거래소에서 사고팔 수 있게 만든 상품입니다.',
              '분산은 한 종목이나 한 업종에 집중된 위험을 낮출 수 있지만, 시장 전체의 하락은 피하지 못합니다.',
              'ETF에는 자산으로 계산한 NAV와 거래소에서 형성되는 시장가격이 있습니다.',
              '비용·현금 보유·구성종목 조정 등의 영향으로 ETF 수익률은 지수와 차이가 날 수 있습니다.',
              'ETF를 고를 때는 무엇을 담았는지, 무엇을 따라가는지, 비용이 얼마인지 확인합니다.',
            ]}
          />
        </>
      ) : null}
    </>
  );
}
