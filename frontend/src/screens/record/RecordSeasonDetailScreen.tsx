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

import { getMySeasonRecordDetail } from '../../features/record/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import CTAButton from '../../components/common/CTAButton';
import InlineEmptyState from '../../components/states/InlineEmptyState';

type Props = NativeStackScreenProps<RecordStackParamList, 'RecordSeasonDetail'>;

function displayValue(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

export default function RecordSeasonDetailScreen({ route, navigation }: Props) {
  const { seasonId } = route.params;

  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonDetail(seasonId),
    queryFn: () => getMySeasonRecordDetail(seasonId),
  });

  const viewState = useMemo(() => {
    if (detailQuery.isLoading) return 'record_detail_loading';

    const errorCode =
      (detailQuery.error as any)?.response?.data?.error?.code ?? null;

    if (errorCode === 'NOT_FOUND') return 'record_detail_missing';
    if (!detailQuery.data) return 'record_detail_error';

    return 'record_detail_ready';
  }, [detailQuery.isLoading, detailQuery.error, detailQuery.data]);

  if (viewState === 'record_detail_loading') {
    return <FullPageLoading message="시즌 전적을 불러오는 중입니다." />;
  }

  if (viewState === 'record_detail_missing') {
    return (
      <ErrorState
        title="해당 시즌 전적이 없습니다."
        message="유효하지 않은 시즌이거나 접근할 수 없는 전적입니다."
      />
    );
  }

  if (viewState === 'record_detail_error' || !detailQuery.data) {
    return (
      <ErrorState
        title="시즌 전적을 불러오지 못했습니다."
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
  const totalFillCount = summary.totalFillCount ?? summary.fillCount;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.record.seasonDetailScreen}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.title}>{season.name}</Text>
          <Text style={styles.helper}>
            {season.startAt} ~ {season.endAt}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>핵심 결과</Text>
          <Text style={styles.helper}>
            최종 순위 {finalRank ? `#${finalRank}` : '-'}
          </Text>
          <Text style={styles.helper}>최종 등급 {displayValue(finalTier)}</Text>
          <Text style={styles.helper}>최종 수익률 {displayValue(finalReturnRate)}%</Text>
          <Text style={styles.helper}>최종 자산 {displayValue(finalTotalAssetKrw)} KRW</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>시즌 자산 변화</Text>
          {equityChart.length === 0 ? (
            <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
          ) : (
            equityChart.map((point) => (
              <Text key={point.time} style={styles.helper}>
                {point.time} · {point.totalAssetKrw}
              </Text>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>통계</Text>
          <Text style={styles.helper}>총 거래 횟수 {displayValue(totalFillCount)}</Text>
          <Text style={styles.helper}>MDD {displayValue(maxDrawdown)}%</Text>
          <Text style={styles.helper}>최고 수익 종목 {stats.bestAsset ?? '-'}</Text>
          <Text style={styles.helper}>최대 손실 종목 {stats.worstAsset ?? '-'}</Text>
        </View>

        <View style={styles.row}>
          <CTAButton
            testID={TEST_IDS.record.seasonDetailProfitAnalysisCta}
            label="수익 분석"
            onPress={() =>
              navigation.navigate('RecordProfitAnalysis', { seasonId })
            }
            style={styles.flex}
          />
          <CTAButton
            testID={TEST_IDS.record.seasonDetailOrdersCta}
            label="거래 내역 보기"
            onPress={() => navigation.navigate('RecordOrderList', { seasonId })}
            style={styles.flex}
          />
        </View>

        <View style={styles.row}>
          <CTAButton
            testID={TEST_IDS.record.seasonDetailExchangesCta}
            label="환전 내역 보기"
            onPress={() => navigation.navigate('RecordExchangeList', { seasonId })}
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
});
