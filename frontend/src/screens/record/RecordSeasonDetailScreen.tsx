import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, Platform } from '../../theme/native';
import { useQuery } from '@tanstack/react-query';
import type { RecordSeasonDetailScreenProps } from '../../app/navigation/types';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { semantic } from '../../theme/tokens';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { getMySeasonRecordDetail } from '../../features/record/api';
import { getApiErrorCode } from '../../services/api/errorMapper';
import { formatKstDateTime } from '../../utils/format';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import CTAButton from '../../components/common/CTAButton';
import RecordMetric from './RecordMetric';

export default function RecordSeasonDetailScreen({ route, navigation }: RecordSeasonDetailScreenProps) {
  const { seasonId } = route.params;
  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasonDetail(seasonId),
    queryFn: () => getMySeasonRecordDetail(seasonId),
  });
  const refresh = usePullToRefresh([detailQuery]);

  if (detailQuery.isLoading) return <FullPageLoading message="시즌 전적을 불러오는 중입니다." />;
  if (!detailQuery.data) {
    const code = getApiErrorCode(detailQuery.error);
    return <ErrorState
      title={code === 'SEASON_NOT_FOUND' || code === 'NOT_FOUND' ? '해당 시즌 전적이 없습니다.' : '시즌 전적을 불러오지 못했습니다.'}
      message="잠시 후 다시 시도해주세요."
      onRetry={() => { void detailQuery.refetch(); }}
    />;
  }

  const { season, participant, performance, profitAnalysis } = detailQuery.data;
  const settled = season.status === 'settled';
  const performanceAvailable = performance.state === 'available';

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView refreshControl={refresh.refreshControl} testID={TEST_IDS.record.seasonDetailScreen} contentContainerStyle={styles.content}>
        <View style={styles.context}>
          <Text accessibilityRole="header" style={styles.title}>{season.name}</Text>
          <Text style={styles.helper}>
            {formatKstDateTime(season.startAt).slice(0, 10)} ~ {formatKstDateTime(season.endAt).slice(0, 10)}
          </Text>
          {!settled ? <Text style={styles.helper}>{season.status === 'active' ? '진행 중' : season.status === 'upcoming' ? '시작 예정' : '정산 대기'}</Text> : null}
        </View>
        <View style={styles.card}>
          <RecordMetric label={settled ? '최종 수익률' : '수익률'} value={performanceAvailable ? performance.returnRate : null} kind="rate" prominent testID="record-detail-return" />
          <View style={styles.metrics}>
            <View style={styles.cell}>
              <RecordMetric label={settled ? '최종 자산' : '총자산'} value={performanceAvailable ? performance.totalAssetKrw : null} signed={false} testID="record-detail-assets" />
            </View>
            <View style={styles.cell}>
              <RecordMetric label="총 손익" value={profitAnalysis.state === 'available' ? profitAnalysis.totalPnlKrw : null} testID="record-detail-pnl" />
            </View>
            <View style={styles.cell}>
              <Text style={styles.label}>{settled ? '최종 순위' : '순위'}</Text>
              <Text testID="record-detail-rank" style={styles.value}>{settled && participant?.finalRank != null ? `#${participant.finalRank}` : '-'}</Text>
            </View>
            <View style={styles.cell}>
              <Text style={styles.label}>{settled ? '최종 등급' : '등급'}</Text>
              <Text testID="record-detail-tier" style={styles.value}>{settled ? participant?.finalTier || '-' : '-'}</Text>
            </View>
          </View>
          {!performanceAvailable ? <Text style={styles.helper}>성과 데이터를 확인할 수 없습니다.</Text> : null}
          {profitAnalysis.state !== 'available' ? <Text style={styles.helper}>총 손익을 확인할 수 없습니다. 수익 분석에서 확인 가능한 내역을 볼 수 있습니다.</Text> : null}
        </View>
        <View style={styles.actions}>
          <CTAButton testID={TEST_IDS.record.seasonDetailProfitAnalysisCta} label="수익 분석" onPress={() => navigation.navigate('RecordProfitAnalysis', { seasonId })} style={styles.action} />
          <CTAButton variant="secondary" testID={TEST_IDS.record.seasonDetailOrdersCta} label="거래 내역 보기" onPress={() => navigation.navigate('TradeHistory', { seasonId })} style={styles.action} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, gap: 16, paddingBottom: 24 },
  context: { gap: 6, minWidth: 0 },
  title: { fontSize: 22, lineHeight: 32, fontWeight: '700' },
  helper: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  card: { borderWidth: 1, borderColor: semantic.border, borderRadius: 14, padding: 16, backgroundColor: semantic.surface, gap: 20, minWidth: 0 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  cell: { flexBasis: 140, flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 4 },
  label: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  value: { fontSize: 22, lineHeight: 32, fontWeight: '700', flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: { flexBasis: 140, flexGrow: 1, flexShrink: 1, minWidth: 0 },
});
