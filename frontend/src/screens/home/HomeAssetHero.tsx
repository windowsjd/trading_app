import React from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { TEST_IDS } from '../../constants/testIds';
import type { TradingAccountPortfolioSummaryDto, TradingAccountPortfolioDto } from '../../features/tradingAccount/api';
import { getReturnRateMethodLabel } from '../../features/tradingAccount/accountDisplay';
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

export default function HomeAssetHero({ summary, finalResult, settled = false, compactBottom = false, compactTop = false, unavailableMessage, aside }: Props) {
  const result = settled ? (finalResult?.state === 'available' ? finalResult : null) : summary;
  return (
    <View testID={TEST_IDS.home.summaryCard} style={[styles.heroRow, compactBottom && styles.compactBottom, compactTop && styles.compactTop]}>
    <View style={styles.hero}>
      <Text style={styles.label}>{settled ? '최종 자산' : '총 자산'}</Text>
      {result ? (
        <>
          <Text testID={TEST_IDS.home.totalAsset} style={styles.total}>
            {formatKrw(result.totalAssetKrw)}원
          </Text>
          <View style={styles.performance}>
            <Text style={styles.metric}>
              {/* Home's season context makes the initial-capital explanation redundant. */}
              {result.returnRateMethod === 'initial_capital'
                ? '시즌 수익률'
                : getReturnRateMethodLabel(result.returnRateMethod)}{' '}
              <Text style={performanceStyle(result.returnRate)}>
                {result.returnRate === null || result.returnRate === undefined
                  ? '알 수 없음'
                  : `${formatPercent(result.returnRate)}%`}
              </Text>
            </Text>
            {!settled && summary ? <Text style={styles.metric}>
              평가 손익{' '}
              <Text style={performanceStyle(summary.unrealizedPnlKrw)}>
                {formatKrw(summary.unrealizedPnlKrw)}원
              </Text>
            </Text> : null}
            {!settled && summary?.futuresUnrealizedPnlKrw !== undefined ? <Text style={styles.metric}>
              선물 Mark 미실현손익{' '}<Text style={performanceStyle(summary.futuresUnrealizedPnlKrw)}>{formatKrw(summary.futuresUnrealizedPnlKrw)}원</Text>
            </Text> : null}
          </View>
        </>
      ) : (
        <InlineEmptyState
          title="수익률을 계산할 수 없습니다."
          message={unavailableMessage ?? '계정 성과 데이터가 아직 준비되지 않았습니다.'}
        />
      )}
    </View>
    {/* Wraps below the numbers when long amounts or large fonts need the width. */}
    {aside ? <View style={styles.aside}>{aside}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heroRow: { paddingVertical: 12, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8, minWidth: 0 },
  hero: { gap: 8, minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: 190 },
  aside: { flexShrink: 0, marginLeft: 'auto' },
  compactBottom: { paddingBottom: 0 },
  compactTop: { paddingTop: 0 },
  label: { fontSize: 18, fontWeight: '700', lineHeight: 27, color: semantic.secondary },
  total: { fontSize: 36, fontWeight: '700', lineHeight: 46, flexShrink: 1, fontVariant: ['tabular-nums'] },
  performance: { gap: 4, marginTop: 4 },
  metric: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  up: { color: financial.rise },
  down: { color: financial.fall },
});
