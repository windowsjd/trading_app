import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { DonutChart, LineChart } from '../../components/charts';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import type {
  TradingAccountEquityDto,
  TradingAccountPortfolioDto,
} from '../../features/tradingAccount/api';
import { formatKrwDecimal } from '../../utils/format';

const krw = (value: string | number) => `${formatKrwDecimal(value)}원`;

/** Shared read UI only; queries, integrity gates and mode-specific UI stay in each home. */
export default function HomePortfolioCharts({
  portfolio,
  equity,
  loading,
  failed,
  general,
}: {
  portfolio: TradingAccountPortfolioDto;
  equity: TradingAccountEquityDto | undefined;
  loading: boolean;
  failed: boolean;
  general: boolean;
}) {
  const allocation = portfolio.allocation;
  const segments =
    allocation.state === 'available'
      ? [
          { key: 'cash', label: '현금', value: allocation.cashKrwValue },
          {
            key: 'domestic',
            label: '국내 주식',
            value: allocation.domesticStockValueKrw,
          },
          { key: 'us', label: '미국 주식', value: allocation.usStockValueKrw },
          {
            key: 'crypto',
            label: '암호화폐',
            value: allocation.cryptoValueKrw,
          },
        ]
      : [];
  const points = useMemo(
    () =>
      equity?.points.map((point) => ({
        x: point.snapshotDate,
        label: point.snapshotDate,
        y: point.totalAssetKrw,
      })) ?? [],
    [equity],
  );
  return (
    <>
      <View style={styles.card}>
        <Text style={styles.label}>자산 배분</Text>
        {allocation.state === 'available' ? (
          <DonutChart
            segments={segments}
            totalLabel={
              portfolio.summary ? krw(portfolio.summary.totalAssetKrw) : '-'
            }
            valueFormatter={krw}
            segmentValueFormatter={(segment) => krw(segment.value)}
            emptyMessage="자산 배분 정보를 표시할 수 없습니다."
          />
        ) : (
          <InlineEmptyState message="자산 배분 정보를 표시할 수 없습니다." />
        )}
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>자산 추이</Text>
        <Text style={styles.note}>최근 30일 · 기록이 있는 날짜의 총 자산</Text>
        {general ? (
          <Text style={styles.note}>
            총 자산에는 광고 보상 등 외부 자금이 포함됩니다. 투자 성과는 위
            시간가중 수익률을 확인하세요.
          </Text>
        ) : null}
        {loading ? (
          <SectionSkeleton lines={4} />
        ) : failed ? (
          <InlineEmptyState message="자산 추이를 불러오지 못했습니다." />
        ) : (
          <LineChart
            points={points}
            pointValueFormatter={(point) => krw(point.y)}
            emptyMessage="표시할 일별 자산 기록이 없습니다."
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  label: { fontSize: 13, color: '#666' },
  note: { fontSize: 12, color: '#666', lineHeight: 18 },
});
