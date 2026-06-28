import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RecordStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getMySeasonRecordDetail,
  getMySeasonEquity,
  type ProfitAnalysisItemDto,
  type RecordSeasonEquityPointDto,
} from '../../features/record/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import { LineChart, type LineChartPoint } from '../../components/charts';

type Props = NativeStackScreenProps<
  RecordStackParamList,
  'RecordProfitAnalysis'
>;

function displayValue(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function displayRank(value?: number | null) {
  return value === null || value === undefined ? '-' : `#${value}`;
}

function displayPercent(value?: string | null) {
  return value ? `${value}%` : '-';
}

function getEquityChartPoints(
  points: RecordSeasonEquityPointDto[],
): LineChartPoint[] {
  return points.map((point) => ({
    x: point.time,
    y: point.totalAssetKrw,
    label: point.time,
  }));
}

function formatKrwChartValue(value: number) {
  return `${value.toFixed(0)} KRW`;
}

function ProfitAssetSummary({
  label,
  asset,
}: {
  label: string;
  asset: ProfitAnalysisItemDto | null;
}) {
  return (
    <View style={styles.assetSummaryRow}>
      <Text style={styles.itemTitle}>{label}</Text>
      {asset ? (
        <>
          <Text style={styles.helper}>
            {asset.symbol} · {asset.name}
          </Text>
          <Text style={styles.helper}>
            손익 {displayValue(asset.totalPnlKrw)} KRW
          </Text>
          <Text style={styles.helper}>
            수익률 {displayPercent(asset.returnRate)}
          </Text>
        </>
      ) : (
        <Text style={styles.helper}>-</Text>
      )}
    </View>
  );
}

export default function RecordProfitAnalysisScreen({
  route,
  navigation,
}: Props) {
  const { seasonId } = route.params;

  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonDetail(seasonId),
    queryFn: () => getMySeasonRecordDetail(seasonId),
  });

  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonEquity({
      seasonId,
      limit: 500,
      offset: 0,
    }),
    queryFn: () =>
      getMySeasonEquity({
        seasonId,
        limit: 500,
        offset: 0,
      }),
  });

  if (detailQuery.isLoading) {
    return <FullPageLoading message="수익 분석을 불러오는 중입니다." />;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ErrorState
        title="수익 분석을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => detailQuery.refetch()}
      />
    );
  }

  const { season, participant, performance, activitySummary, profitAnalysis } =
    detailQuery.data;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.record.profitAnalysisScreen}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.title}>{season.name}</Text>
          <Text style={styles.helper}>
            {season.startAt} ~ {season.endAt}
          </Text>
          <Text style={styles.helper}>시즌 상태 {season.status}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>시즌 요약</Text>
          <Text style={styles.helper}>
            최종/현재 순위 {displayRank(participant?.finalRank)}
          </Text>
          <Text style={styles.helper}>
            등급 {displayValue(participant?.finalTier)}
          </Text>
          <Text style={styles.helper}>
            총자산 {displayValue(performance.totalAssetKrw)} KRW
          </Text>
          <Text style={styles.helper}>
            수익률 {displayPercent(performance.returnRate)}
          </Text>
          <Text style={styles.helper}>
            MDD {displayPercent(performance.maxDrawdown)}
          </Text>
          <Text style={styles.helper}>
            스냅샷 일자 {displayValue(performance.snapshotDate)}
          </Text>
          <Text style={styles.helper}>
            수집 시각 {displayValue(performance.capturedAt)}
          </Text>
          {performance.state === 'unavailable' ? (
            <InlineEmptyState
              message={performance.message ?? '성과 데이터가 아직 없습니다.'}
            />
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>손익 요약</Text>
          <Text style={styles.helper}>상태 {profitAnalysis.state}</Text>
          <Text style={styles.helper}>
            실현 손익 {displayValue(profitAnalysis.totalRealizedPnlKrw)} KRW
          </Text>
          <Text style={styles.helper}>
            평가 손익 {displayValue(profitAnalysis.totalUnrealizedPnlKrw)} KRW
          </Text>
          <Text style={styles.helper}>
            총 손익 {displayValue(profitAnalysis.totalPnlKrw)} KRW
          </Text>
          {profitAnalysis.state === 'partial_unavailable' ? (
            <Text style={styles.warningText}>
              일부 자산 평가 데이터가 없어 손익 분석이 부분 표시됩니다.
            </Text>
          ) : null}
          {profitAnalysis.state === 'unavailable' ? (
            <Text style={styles.warningText}>
              손익 분석 데이터를 사용할 수 없습니다.
            </Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>최고/최악 자산</Text>
          <ProfitAssetSummary
            label="최고 수익"
            asset={profitAnalysis.bestAsset}
          />
          <ProfitAssetSummary
            label="최대 손실"
            asset={profitAnalysis.worstAsset}
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>자산별 손익</Text>
          {profitAnalysis.items.length === 0 ? (
            <InlineEmptyState message="표시할 자산별 손익 데이터가 없습니다." />
          ) : (
            profitAnalysis.items.map((item) => (
              <View key={item.assetId} style={styles.assetRow}>
                <Text style={styles.itemTitle}>{item.symbol}</Text>
                <Text style={styles.helper}>{item.name}</Text>
                <Text style={styles.helper}>
                  {item.assetType} · {item.positionState} · {item.valuationState}
                </Text>
                <Text style={styles.helper}>
                  실현 {displayValue(item.realizedPnlKrw)} KRW
                </Text>
                <Text style={styles.helper}>
                  평가 {displayValue(item.unrealizedPnlKrw)} KRW
                </Text>
                <Text style={styles.helper}>
                  총 손익 {displayValue(item.totalPnlKrw)} KRW
                </Text>
                <Text style={styles.helper}>
                  수익률 {displayPercent(item.returnRate)}
                </Text>
              </View>
            ))
          )}
        </View>

        {profitAnalysis.valuationErrors.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.label}>평가 오류</Text>
            {profitAnalysis.valuationErrors.map((error) => (
              <View key={`${error.assetId}-${error.code}`} style={styles.errorRow}>
                <Text style={styles.itemTitle}>{error.assetId}</Text>
                <Text style={styles.helper}>{error.code}</Text>
                <Text style={styles.warningText}>{error.message}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.label}>거래 요약</Text>
          <Text style={styles.helper}>
            총 주문 {displayValue(activitySummary.orders.total)}
          </Text>
          <Text style={styles.helper}>
            체결 {displayValue(activitySummary.orders.executed)}
          </Text>
          <Text style={styles.helper}>
            제출 {displayValue(activitySummary.orders.submitted)}
          </Text>
          <Text style={styles.helper}>
            취소 {displayValue(activitySummary.orders.canceled)}
          </Text>
          <Text style={styles.helper}>
            거절 {displayValue(activitySummary.orders.rejected)}
          </Text>
          <Text style={styles.helper}>
            환전 {displayValue(activitySummary.exchanges.total)}
          </Text>
          <Text style={styles.helper}>
            지갑 원장 {displayValue(activitySummary.walletTransactions.total)}
          </Text>
          <Text style={styles.helper}>
            오픈 포지션 {displayValue(activitySummary.positions.open)}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>수익 추이 차트</Text>
          {equityQuery.isLoading ? (
            <SectionSkeleton lines={5} />
          ) : equityQuery.isError ? (
            <View style={styles.chartState}>
              <InlineEmptyState message="수익 추이를 불러오지 못했습니다." />
              <CTAButton
                label="다시 시도"
                onPress={() => equityQuery.refetch()}
              />
            </View>
          ) : equityQuery.data?.state === 'not_joined' ? (
            <InlineEmptyState message="시즌 참가 기록이 없어 수익 추이를 표시할 수 없습니다." />
          ) : equityQuery.data?.state === 'empty' ? (
            <InlineEmptyState message="수익 추이 데이터가 아직 없습니다." />
          ) : !equityQuery.data || equityQuery.data.points.length < 2 ? (
            <InlineEmptyState message="수익 추이를 표시하려면 데이터가 더 필요합니다." />
          ) : (
            <LineChart
              points={getEquityChartPoints(equityQuery.data.points)}
              valueFormatter={formatKrwChartValue}
              emptyMessage="수익 추이를 표시하려면 데이터가 더 필요합니다."
            />
          )}
        </View>

        <View style={styles.row}>
          <CTAButton
            label="주문 내역"
            onPress={() => navigation.navigate('RecordOrderList', { seasonId })}
            style={styles.flex}
          />
          <CTAButton
            label="환전 내역"
            onPress={() =>
              navigation.navigate('RecordExchangeList', { seasonId })
            }
            style={styles.flex}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  title: { fontSize: 22, fontWeight: '700' },
  label: { fontSize: 13, color: '#666' },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  warningText: { fontSize: 13, color: '#7a4b00' },
  chartState: { gap: 8 },
  assetSummaryRow: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingTop: 10,
    gap: 4,
  },
  assetRow: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingTop: 10,
    gap: 4,
  },
  errorRow: {
    borderTopWidth: 1,
    borderTopColor: '#f1d0d0',
    paddingTop: 10,
    gap: 4,
  },
});
