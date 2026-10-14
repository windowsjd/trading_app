import React, { useState } from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { TEST_IDS } from '../../constants/testIds';
import type { TradingAccountPortfolioSummaryDto, TradingAccountPortfolioDto } from '../../features/tradingAccount/api';
import { homeUnrealizedPnlKrw } from '../../features/tradingAccount/homePortfolio';
import { formatKrw, formatPercent } from '../../utils/format';
import InlineEmptyState from '../../components/states/InlineEmptyState';

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

const GAP = 12;

export default function HomeAssetHero({ summary, finalResult, settled = false, compactBottom = false, compactTop = false, unavailableMessage, aside }: Props) {
  const result = settled ? (finalResult?.state === 'available' ? finalResult : null) : summary;
  const total = result ? `${formatKrw(result.totalAssetKrw)}원` : '';
  const unrealizedPnl = !settled && summary ? homeUnrealizedPnlKrw(summary) : null;
  // The emblem stays beside the total only when the total's natural width
  // leaves room for it (measured, so fonts and long amounts never wrap the
  // total or meet the emblem); otherwise it sits lower, beside the
  // performance lines. Until measured, the lower position is the safe one.
  const [row, setRow] = useState(0);
  const [totalWidth, setTotalWidth] = useState(0);
  const [asideWidth, setAsideWidth] = useState(0);
  const beside = !result || (row > 0 && totalWidth > 0 && asideWidth > 0 && totalWidth + GAP + asideWidth <= row);
  const asideView = aside ? (
    <View testID="home-hero-aside" style={styles.aside} onLayout={event => setAsideWidth(event.nativeEvent.layout.width)}>{aside}</View>
  ) : null;
  return (
    <View style={styles.host}>
    {asideView && result ? (
      // Measures the total unwrapped (capped at the row), outside the card's
      // content; never shown or read.
      <Text style={[styles.total, styles.measure]} onLayout={event => setTotalWidth(event.nativeEvent.layout.width)}
        accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>{total}</Text>
    ) : null}
    <View testID={TEST_IDS.home.summaryCard} style={[styles.heroRow, compactBottom && styles.compactBottom, compactTop && styles.compactTop]}
      onLayout={event => setRow(event.nativeEvent.layout.width)}>
    <View style={[styles.hero, asideView && beside && totalWidth > 0 && { flexBasis: totalWidth }]}>
      <Text style={styles.label}>{settled ? '최종 자산' : '총 자산'}</Text>
      {result ? (
        <>
          <Text testID={TEST_IDS.home.totalAsset} style={styles.total}>
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
  heroRow: { paddingVertical: 12, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: GAP, rowGap: 8, minWidth: 0 },
  hero: { gap: 8, minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: 190 },
  aside: { flexShrink: 0, marginLeft: 'auto' },
  measure: { position: 'absolute', left: 0, top: 0, opacity: 0 },
  // Lower emblem position: beside the performance lines, below the total.
  performanceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: GAP, rowGap: 8, minWidth: 0 },
  compactBottom: { paddingBottom: 0 },
  compactTop: { paddingTop: 0 },
  label: { fontSize: 18, fontWeight: '700', lineHeight: 27, color: semantic.secondary },
  total: { fontSize: 36, fontWeight: '700', lineHeight: 46, flexShrink: 1, fontVariant: ['tabular-nums'] },
  performance: { gap: 4, marginTop: 4, flexGrow: 1, flexShrink: 1, flexBasis: 150, minWidth: 0 },
  metric: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  up: { color: financial.rise },
  down: { color: financial.fall },
});
