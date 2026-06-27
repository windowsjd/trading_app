import React, { useMemo } from 'react';
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
  getMySeasonExchanges,
  getMySeasonOrders,
  getMySeasonRecordDetail,
  type RecordExchangeItemDto,
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

const SUMMARY_PAGE_SIZE = 50;

function displayValue(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getEquityChartPoints(
  points: Array<{ time: string; totalAssetKrw: string }>,
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

function getTotalCount(
  page?: { pagination?: { total?: number }; items?: unknown[] } | null,
) {
  if (!page) return null;
  return page.pagination?.total ?? page.items?.length ?? 0;
}

function getExchangeFeeRows(
  exchanges?: {
    items: RecordExchangeItemDto[];
    pagination?: { nextOffset?: number | null };
  } | null,
) {
  if (!exchanges || exchanges.pagination?.nextOffset !== null) return null;

  const totals = new Map<string, number>();

  exchanges.items.forEach((exchange) => {
    const feeAmount = Number(exchange.feeAmount);
    if (!Number.isFinite(feeAmount) || feeAmount <= 0) return;
    const currency = exchange.feeCurrency ?? '기타';
    totals.set(currency, (totals.get(currency) ?? 0) + feeAmount);
  });

  return Array.from(totals.entries()).map(([currency, amount]) => ({
    currency,
    amount,
  }));
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

  const allOrdersQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonOrders({
      seasonId,
      limit: 1,
      offset: 0,
    }),
    queryFn: () => getMySeasonOrders({ seasonId, limit: 1, offset: 0 }),
  });

  const buyOrdersQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonOrders({
      seasonId,
      limit: 1,
      offset: 0,
      side: 'buy',
    }),
    queryFn: () =>
      getMySeasonOrders({ seasonId, limit: 1, offset: 0, side: 'buy' }),
  });

  const sellOrdersQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonOrders({
      seasonId,
      limit: 1,
      offset: 0,
      side: 'sell',
    }),
    queryFn: () =>
      getMySeasonOrders({ seasonId, limit: 1, offset: 0, side: 'sell' }),
  });

  const exchangesQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonExchanges({
      seasonId,
      limit: SUMMARY_PAGE_SIZE,
      offset: 0,
    }),
    queryFn: () =>
      getMySeasonExchanges(seasonId, {
        limit: SUMMARY_PAGE_SIZE,
        offset: 0,
      }),
  });

  const equityChartPoints = useMemo(
    () => getEquityChartPoints(detailQuery.data?.equityChart ?? []),
    [detailQuery.data?.equityChart],
  );

  const exchangeFeeRows = useMemo(
    () => getExchangeFeeRows(exchangesQuery.data),
    [exchangesQuery.data],
  );

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

  const { season, summary, equityChart } = detailQuery.data;
  const stats = detailQuery.data.stats ?? {};
  const finalRank = summary.finalRank ?? summary.rank;
  const finalTier = summary.finalTier ?? summary.tier;
  const finalReturnRate = summary.finalReturnRate ?? summary.returnRate;
  const finalTotalAssetKrw = summary.finalTotalAssetKrw ?? summary.totalAssetKrw;
  const maxDrawdown = summary.maxDrawdown ?? summary.mdd;
  const totalOrders = getTotalCount(allOrdersQuery.data);
  const buyOrders = getTotalCount(buyOrdersQuery.data);
  const sellOrders = getTotalCount(sellOrdersQuery.data);
  const totalExchanges = getTotalCount(exchangesQuery.data);
  const transactionSummaryLoading =
    allOrdersQuery.isLoading ||
    buyOrdersQuery.isLoading ||
    sellOrdersQuery.isLoading ||
    exchangesQuery.isLoading;
  const transactionSummaryError =
    allOrdersQuery.isError ||
    buyOrdersQuery.isError ||
    sellOrdersQuery.isError ||
    exchangesQuery.isError;

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
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>시즌 요약</Text>
          <Text style={styles.helper}>
            총자산 {displayValue(finalTotalAssetKrw)} KRW
          </Text>
          <Text style={styles.helper}>
            수익률 {displayValue(finalReturnRate)}%
          </Text>
          <Text style={styles.helper}>MDD {displayValue(maxDrawdown)}%</Text>
          <Text style={styles.helper}>
            최종/현재 순위 {finalRank ? `#${finalRank}` : '-'}
          </Text>
          <Text style={styles.helper}>등급 {displayValue(finalTier)}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>수익 추이</Text>
          {equityChart.length > 0 ? (
            <LineChart
              points={equityChartPoints}
              valueFormatter={formatKrwChartValue}
              emptyMessage="수익 추이 데이터가 아직 없습니다."
            />
          ) : (
            <InlineEmptyState message="수익 추이 데이터가 아직 없습니다." />
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>거래 요약</Text>
          {transactionSummaryLoading ? (
            <SectionSkeleton lines={5} />
          ) : transactionSummaryError ? (
            <InlineEmptyState
              title="거래 요약을 불러오지 못했습니다."
              message="시즌 요약은 계속 볼 수 있습니다."
            />
          ) : (
            <>
              <Text style={styles.helper}>총 주문 수 {displayValue(totalOrders)}</Text>
              <Text style={styles.helper}>매수 {displayValue(buyOrders)}</Text>
              <Text style={styles.helper}>매도 {displayValue(sellOrders)}</Text>
              <Text style={styles.helper}>
                총 환전 수 {displayValue(totalExchanges)}
              </Text>
              {exchangeFeeRows && exchangeFeeRows.length > 0 ? (
                exchangeFeeRows.map((row) => (
                  <Text key={row.currency} style={styles.helper}>
                    환전 수수료 {row.amount.toFixed(6)} {row.currency}
                  </Text>
                ))
              ) : (
                <Text style={styles.subtle}>
                  전체 수수료 합산은 백엔드 집계 API가 필요합니다.
                </Text>
              )}
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>자산/거래 기여도</Text>
          {stats.bestAsset || stats.worstAsset ? (
            <>
              <Text style={styles.helper}>
                최고 수익 종목 {displayValue(stats.bestAsset)}
              </Text>
              <Text style={styles.helper}>
                최대 손실 종목 {displayValue(stats.worstAsset)}
              </Text>
              <Text style={styles.subtle}>
                상세 기여도는 백엔드 집계 API 필요
              </Text>
            </>
          ) : (
            <InlineEmptyState message="상세 기여도는 백엔드 집계 API 필요" />
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
  helper: { fontSize: 14, color: '#444' },
  subtle: { fontSize: 13, color: '#777' },
});
