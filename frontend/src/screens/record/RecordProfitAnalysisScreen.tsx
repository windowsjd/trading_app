import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, Platform, useWindowDimensions } from '../../theme/native';
import { useQuery } from '@tanstack/react-query';
import type { RecordProfitAnalysisScreenProps } from '../../app/navigation/types';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { semantic } from '../../theme/tokens';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { getMySeasonRecordDetail, getMySeasonEquity, type ProfitAnalysisItemDto } from '../../features/record/api';
import { getRecordFinancialDisplay } from '../../features/record/financialDisplay';
import { formatKrwDecimal, getAssetNameDisplay } from '../../utils/format';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import { LineChart } from '../../components/charts';
import RecordMetric from './RecordMetric';

function ProfitAsset({ asset, label, testID }: { asset: ProfitAnalysisItemDto | null; label?: string; testID: string }) {
  const name = asset ? getAssetNameDisplay(asset) : null;
  // Failed valuation totals retain realized PnL but do not represent complete
  // profit/loss. Keep the canonical asset identity and leave that total blank.
  const pnl = getRecordFinancialDisplay(asset?.valuationState === 'available' ? asset.totalPnlKrw : null);
  const rate = getRecordFinancialDisplay(asset?.valuationState === 'available' && asset.returnRateState === 'available' ? asset.returnRate : null, 'rate');
  return (
    <View testID={testID} style={styles.assetRow}>
      <View style={styles.assetName}>
        {label ? <Text style={styles.label}>{label}</Text> : null}
        <Text style={styles.itemTitle}>{name?.primary ?? '-'}</Text>
        {name?.secondary ? <Text style={styles.helper}>{name.secondary}</Text> : null}
      </View>
      <View style={styles.assetValues}>
        <Text testID={`${testID}-pnl`} style={[styles.assetPnl, { color: pnl.color }]}>{pnl.text}</Text>
        <Text testID={`${testID}-return`} style={[styles.assetRate, { color: rate.color }]}>{rate.text}</Text>
      </View>
    </View>
  );
}

export default function RecordProfitAnalysisScreen({ route, navigation }: RecordProfitAnalysisScreenProps) {
  const { fontScale } = useWindowDimensions();
  const { seasonId } = route.params;
  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonDetail(seasonId),
    queryFn: () => getMySeasonRecordDetail(seasonId),
  });
  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonEquity({ seasonId, limit: 500, offset: 0 }),
    queryFn: () => getMySeasonEquity({ seasonId, limit: 500, offset: 0 }),
  });
  const refresh = usePullToRefresh([detailQuery, equityQuery]);
  if (detailQuery.isLoading) return <FullPageLoading message="수익 분석을 불러오는 중입니다." />;
  if (!detailQuery.data) return <ErrorState title="수익 분석을 불러오지 못했습니다." message="잠시 후 다시 시도해주세요." onRetry={() => { void detailQuery.refetch(); }} />;

  const { season, performance, profitAnalysis } = detailQuery.data;
  const available = profitAnalysis.state === 'available';
  const hasAnalysis = profitAnalysis.state !== 'unavailable';

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView refreshControl={refresh.refreshControl} testID={TEST_IDS.record.profitAnalysisScreen} contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>{season.name}</Text>
        <View style={styles.card}>
          <Text style={styles.heading}>손익 요약</Text>
          <RecordMetric label="총 손익" value={available ? profitAnalysis.totalPnlKrw : null} prominent testID="record-profit-total" />
          <View style={styles.metrics}>
            <View style={styles.cell}><RecordMetric label="수익률" value={performance.state === 'available' ? performance.returnRate : null} kind="rate" testID="record-profit-return" /></View>
            <View style={styles.cell}><RecordMetric label="실현 손익" value={hasAnalysis ? profitAnalysis.totalRealizedPnlKrw : null} testID="record-profit-realized" /></View>
            <View style={styles.cell}><RecordMetric label="평가 손익" value={available ? profitAnalysis.totalUnrealizedPnlKrw : null} testID="record-profit-unrealized" /></View>
          </View>
          {profitAnalysis.state === 'partial_unavailable' ? <Text style={styles.notice}>일부 자산의 평가 데이터를 확인할 수 없어 일부 분석이 표시되지 않습니다.</Text> : null}
          {!hasAnalysis ? <Text style={styles.notice}>수익 분석 데이터를 확인할 수 없습니다.</Text> : null}
          {profitAnalysis.valuationErrors.map(error => <AdminDiagnosticPanel key={error.assetId} diagnostic={error.diagnostic} />)}
        </View>
        <View style={styles.card}>
          <Text style={styles.heading}>자산 추이</Text>
          <View style={[styles.chartViewport, { minHeight: 204 + 18 * Math.max(0, fontScale - 1) }]}>
            {equityQuery.isLoading ? <SectionSkeleton lines={5} />
              : equityQuery.isError && !equityQuery.data ? (
                <View style={styles.chartState}>
                  <InlineEmptyState message="자산 추이를 불러오지 못했습니다." />
                  <CTAButton variant="neutral" label="다시 시도" onPress={() => { void equityQuery.refetch(); }} />
                </View>
              ) : equityQuery.data?.state === 'not_joined' ? <InlineEmptyState message="시즌 참가 기록이 없어 자산 추이를 표시할 수 없습니다." />
                : !equityQuery.data || equityQuery.data.state === 'empty' || equityQuery.data.points.length < 2 ? <InlineEmptyState message="자산 추이를 표시하려면 데이터가 더 필요합니다." />
                  : <LineChart
                    points={equityQuery.data.points.map(point => ({ x: point.time, label: point.time, y: point.totalAssetKrw }))}
                    xScale="time"
                    selectionDisplay="tooltip"
                    pointValueFormatter={point => `${formatKrwDecimal(point.y)}원`}
                    emptyMessage="자산 추이를 표시하려면 데이터가 더 필요합니다."
                  />}
          </View>
        </View>
        <View style={styles.card}>
          <Text style={styles.heading}>대표 손익</Text>
          <ProfitAsset label="최고 수익" asset={hasAnalysis ? profitAnalysis.bestAsset : null} testID="record-profit-best" />
          <ProfitAsset label="최대 손실" asset={hasAnalysis ? profitAnalysis.worstAsset : null} testID="record-profit-worst" />
        </View>
        <View style={styles.card}>
          <Text style={styles.heading}>자산별 손익</Text>
          {!hasAnalysis || profitAnalysis.items.length === 0 ? <InlineEmptyState message="표시할 자산별 손익 데이터가 없습니다." />
            : profitAnalysis.items.map(item => <ProfitAsset key={item.assetId} asset={item} testID={`record-profit-asset-${item.assetId}`} />)}
        </View>
        <CTAButton testID="record-profit-orders-cta" label="거래 내역 보기" onPress={() => navigation.navigate('TradeHistory', { seasonId })} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, gap: 16, paddingBottom: 24 },
  card: { borderWidth: 1, borderColor: semantic.border, borderRadius: 14, padding: 16, backgroundColor: semantic.surface, gap: 12, minWidth: 0 },
  title: { fontSize: 22, lineHeight: 32, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 26, fontWeight: '700' },
  label: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  helper: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  notice: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  cell: { flexBasis: 140, flexGrow: 1, flexShrink: 1, minWidth: 0 },
  chartState: { gap: 8 },
  // Default LineChart: 180 px plot + 6 px gap + 18 px axis (scaled above).
  // minHeight reserves arrival geometry while allowing text/errors to grow.
  chartViewport: { minHeight: 204 },
  assetRow: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderTopColor: semantic.border, paddingTop: 12, columnGap: 12, rowGap: 8, minWidth: 0 },
  assetName: { flexBasis: 140, flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 4 },
  itemTitle: { fontSize: 15, lineHeight: 23, fontWeight: '600' },
  assetValues: { flexBasis: 140, flexGrow: 1, flexShrink: 1, minWidth: 0, alignItems: 'stretch', gap: 4 },
  assetPnl: { fontSize: 18, lineHeight: 26, fontWeight: '700', textAlign: 'right', fontVariant: ['tabular-nums'] },
  assetRate: { fontSize: 13, lineHeight: 20, textAlign: 'right' },
});
