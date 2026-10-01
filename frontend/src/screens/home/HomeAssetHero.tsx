import React from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { TEST_IDS } from '../../constants/testIds';
import type { TradingAccountPortfolioSummaryDto } from '../../features/tradingAccount/api';
import { getReturnRateMethodLabel } from '../../features/tradingAccount/accountDisplay';
import { formatKrw, formatPercent } from '../../utils/format';
import InlineEmptyState from '../../components/states/InlineEmptyState';

type Props = {
  summary: TradingAccountPortfolioSummaryDto | null;
  settled?: boolean;
  unavailableMessage?: string;
};

// Color only: values and return-rate meaning still come from the portfolio API.
function performanceStyle(value: string | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return undefined;
  return amount > 0 ? styles.up : styles.down;
}

export default function HomeAssetHero({ summary, settled = false, unavailableMessage }: Props) {
  return (
    <View testID={TEST_IDS.home.summaryCard} style={styles.hero}>
      <Text style={styles.label}>{settled ? '최종 자산' : '총 자산'}</Text>
      {summary ? (
        <>
          <Text testID={TEST_IDS.home.totalAsset} style={styles.total}>
            {formatKrw(summary.totalAssetKrw)}원
          </Text>
          <View style={styles.performance}>
            <Text style={styles.metric}>
              {getReturnRateMethodLabel(summary.returnRateMethod)}{' '}
              <Text style={performanceStyle(summary.returnRate)}>
                {summary.returnRate === null || summary.returnRate === undefined
                  ? '알 수 없음'
                  : `${formatPercent(summary.returnRate)}%`}
              </Text>
            </Text>
            <Text style={styles.metric}>
              평가 손익{' '}
              <Text style={performanceStyle(summary.unrealizedPnlKrw)}>
                {formatKrw(summary.unrealizedPnlKrw)}원
              </Text>
            </Text>
          </View>
        </>
      ) : (
        <InlineEmptyState
          title="수익률을 계산할 수 없습니다."
          message={unavailableMessage ?? '계정 성과 데이터가 아직 준비되지 않았습니다.'}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { paddingVertical: 12, gap: 8, minWidth: 0 },
  label: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  total: { fontSize: 36, fontWeight: '700', lineHeight: 46, flexShrink: 1, fontVariant: ['tabular-nums'] },
  performance: { gap: 4, marginTop: 4 },
  metric: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  up: { color: financial.rise },
  down: { color: financial.fall },
});
