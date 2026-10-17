import React, { useState } from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { TEST_IDS } from '../../constants/testIds';
import type { TradingAccountPortfolioSummaryDto, TradingAccountPortfolioDto } from '../../features/tradingAccount/api';
import { homeUnrealizedPnlKrw } from '../../features/tradingAccount/homePortfolio';
import { formatKrw, formatPercent } from '../../utils/format';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import { fitHeroTotal, HERO_ASIDE_GAP, HERO_TOTAL_FONT_SIZE, HERO_TOTAL_MIN_FONT_SIZE } from './heroTotalFit';

type Props = {
  summary: TradingAccountPortfolioSummaryDto | null;
  finalResult?: TradingAccountPortfolioDto['finalResult'];
  settled?: boolean;
  compactBottom?: boolean;
  compactTop?: boolean;
  unavailableMessage?: string;
  /** Season tier emblem, to the right of the numbers. */
  aside?: React.ReactNode;
};

// Color only: values and return-rate meaning still come from the portfolio API.
function performanceStyle(value: string | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return undefined;
  return amount > 0 ? styles.up : styles.down;
}

export default function HomeAssetHero({ summary, finalResult, settled = false, compactBottom = false, compactTop = false, unavailableMessage, aside }: Props) {
  const result = settled ? (finalResult?.state === 'available' ? finalResult : null) : summary;
  const total = result ? `${formatKrw(result.totalAssetKrw)}원` : '';
  const unrealizedPnl = !settled && summary ? homeUnrealizedPnlKrw(summary) : null;
  // The emblem keeps its place beside the total, so the total has one column
  // of fixed width whatever the amount; a total too long for it is drawn
  // smaller to fit (fitHeroTotal, from the measured widths), never cut. Only
  // large text on a narrow phone moves the emblem lower, beside the performance lines.
  const [row, setRow] = useState(0);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [asideWidth, setAsideWidth] = useState(0);
  // Backstop: a drawn total that still breaks onto a second line takes half a
  // point off, until it fits or reaches the minimum. Kept while the measured
  // widths stay the same (an update with as many digits keeps its size).
  const fitInputs = `${row}|${aside ? asideWidth : '-'}|${natural.width}`;
  const [overflow, setOverflow] = useState({ inputs: '', steps: 0 });
  const shrinkSteps = overflow.inputs === fitInputs ? overflow.steps : 0;
  const fit = fitHeroTotal({ row, aside: aside ? asideWidth : null, natural: result ? natural.width : 0,
    glyphs: Array.from(total).length, shrinkSteps });
  const beside = !result || fit.beside;
  // One style object (not an array), sized only when the column needs it.
  const totalStyle = fit.fontSize === HERO_TOTAL_FONT_SIZE ? styles.total : { ...styles.total, fontSize: fit.fontSize };
  const asideView = aside ? (
    <View testID="home-hero-aside" style={styles.aside} onLayout={event => setAsideWidth(event.nativeEvent.layout.width)}>{aside}</View>
  ) : null;
  return (
    <View style={styles.host}>
    {result ? (
      // Measures the total at the base size on one line (a wide row inside a
      // zero-size clip, so a long amount is not capped by the screen and adds
      // no scrollable width); never shown or read.
      <View style={styles.measureClip} pointerEvents="none" accessible={false} accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants" aria-hidden>
        <View style={styles.measureRow}>
          <Text style={styles.total} onLayout={event => setNatural({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
            accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>{total}</Text>
        </View>
      </View>
    ) : null}
    <View testID={TEST_IDS.home.summaryCard} style={[styles.heroRow, compactBottom && styles.compactBottom, compactTop && styles.compactTop]}
      onLayout={event => setRow(event.nativeEvent.layout.width)}>
    <View style={styles.hero}>
      <Text style={styles.label}>{settled ? '최종 자산' : '총 자산'}</Text>
      {result ? (
        <>
          {/* Keyed by its size: a remount reports its layout again, so each step is checked. */}
          <Text key={fit.fontSize} testID={TEST_IDS.home.totalAsset} style={totalStyle} onLayout={event => {
            // The measured one-line height is the same line box (the line height does not change with the size).
            const broke = natural.height > 0 && event.nativeEvent.layout.height > natural.height * 1.5;
            // Beside the emblem a step past the minimum moves the emblem below; otherwise stop at the minimum.
            if (broke && ((!!aside && fit.beside) || fit.fontSize > HERO_TOTAL_MIN_FONT_SIZE)) {
              setOverflow(current => ({ inputs: fitInputs, steps: (current.inputs === fitInputs ? current.steps : 0) + 1 }));
            }
          }}>
            {total}
          </Text>
          <View style={styles.performanceRow}>
          <View style={styles.performance}>
            <Text style={styles.metric}>
              {/* One headline name for every mode; the value is still the
                  response's own method (cumulative principal / season
                  initial capital), never recomputed here. */}
              수익률{' '}
              <Text style={performanceStyle(result.returnRate)}>
                {result.returnRate === null || result.returnRate === undefined
                  ? '알 수 없음'
                  : `${formatPercent(result.returnRate)}%`}
              </Text>
            </Text>
            {/* Spot + futures Mark unrealized PnL in one line. */}
            {!settled && summary ? <Text testID="home-unrealized-pnl" style={styles.metric}>
              평가 손익{' '}
              <Text style={performanceStyle(unrealizedPnl)}>
                {unrealizedPnl === null ? '알 수 없음' : `${formatKrw(unrealizedPnl)}원`}
              </Text>
            </Text> : null}
          </View>
          {beside ? null : asideView}
          </View>
        </>
      ) : (
        <InlineEmptyState
          title="수익률을 계산할 수 없습니다."
          message={unavailableMessage ?? '계정 성과 데이터가 아직 준비되지 않았습니다.'}
        />
      )}
    </View>
    {beside ? asideView : null}
    </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { minWidth: 0 },
  heroRow: { paddingVertical: 12, flexDirection: 'row', alignItems: 'center', columnGap: HERO_ASIDE_GAP, minWidth: 0 },
  // The total's column: everything the emblem leaves, independent of the amount.
  hero: { gap: 8, minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  aside: { flexShrink: 0, marginLeft: 'auto' },
  measureClip: { position: 'absolute', left: 0, top: 0, width: 0, height: 0, overflow: 'hidden', opacity: 0 },
  measureRow: { position: 'absolute', left: 0, top: 0, width: 4096, flexDirection: 'row' },
  // Lower emblem position (large text on a narrow phone only): beside the performance lines, below the total.
  performanceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: HERO_ASIDE_GAP, rowGap: 8, minWidth: 0 },
  compactBottom: { paddingBottom: 0 },
  compactTop: { paddingTop: 0 },
  label: { fontSize: 18, fontWeight: '700', lineHeight: 27, color: semantic.secondary },
  // A smaller fitted size keeps this line height, so the hero never jumps when the amount changes.
  total: { fontSize: HERO_TOTAL_FONT_SIZE, fontWeight: '700', lineHeight: 46, flexShrink: 1, fontVariant: ['tabular-nums'] },
  performance: { gap: 4, marginTop: 4, flexGrow: 1, flexShrink: 1, flexBasis: 150, minWidth: 0 },
  metric: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  up: { color: financial.rise },
  down: { color: financial.fall },
});
