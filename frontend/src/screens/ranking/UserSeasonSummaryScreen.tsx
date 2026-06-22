import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';

import type { UserSeasonSummaryScreenProps } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getRankingTier,
  getUserSeasonSummary,
} from '../../features/ranking/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';

type Props = UserSeasonSummaryScreenProps;

function displayValue(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

export default function UserSeasonSummaryScreen({ route }: Props) {
  const { userId } = route.params;

  const summaryQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.userSeasonSummary(userId),
    queryFn: () => getUserSeasonSummary(userId),
  });

  const viewState = useMemo(() => {
    if (summaryQuery.isLoading) return 'user_summary_loading';

    const errorCode =
      (summaryQuery.error as any)?.response?.data?.error?.code ?? null;

    if (errorCode === 'NOT_FOUND') return 'user_summary_not_found';
    if (!summaryQuery.data) return 'user_summary_error';

    return 'user_summary_ready';
  }, [summaryQuery.isLoading, summaryQuery.error, summaryQuery.data]);

  if (viewState === 'user_summary_loading') {
    return <FullPageLoading message="유저 정보를 불러오는 중입니다." />;
  }

  if (viewState === 'user_summary_not_found') {
    return (
      <SafeAreaView style={styles.centered}>
        <Text testID={TEST_IDS.userSummary.notFound} style={styles.title}>
          해당 유저 정보를 찾을 수 없습니다.
        </Text>
      </SafeAreaView>
    );
  }

  if (viewState === 'user_summary_error' || !summaryQuery.data) {
    return (
      <ErrorState
        title="유저 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => summaryQuery.refetch()}
      />
    );
  }

  const { user, season, allocation } = summaryQuery.data;
  const topPositions = summaryQuery.data.topPositions ?? [];

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.userSummary.screen}
        data={topPositions}
        keyExtractor={(item) => item.assetId}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <>
            <View style={styles.card}>
              <Text style={styles.title}>{user.nickname}</Text>
              <Text style={styles.helper}>
                현재 순위 {season.rank ? `#${season.rank}` : '-'}
              </Text>
              <Text style={styles.helper}>등급 {getRankingTier(season)}</Text>
              <Text style={styles.helper}>
                임시 등급 {displayValue(season.provisionalTier)}
              </Text>
              <Text style={styles.helper}>
                최종 등급 {displayValue(season.finalTier)}
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.label}>현재 시즌 요약</Text>
              <Text style={styles.helper}>수익률 {displayValue(season.returnRate)}%</Text>
              <Text style={styles.helper}>퍼센타일 {displayValue(season.percentile)}%</Text>
              <Text style={styles.helper}>총 자산 {displayValue(season.totalAssetKrw)} KRW</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.label}>포트폴리오 비중</Text>
              <Text style={styles.helper}>현금 {displayValue(allocation.cashKrwValue)}</Text>
              <Text style={styles.helper}>국내 {displayValue(allocation.domesticStockValueKrw)}</Text>
              <Text style={styles.helper}>미국 {displayValue(allocation.usStockValueKrw)}</Text>
              <Text style={styles.helper}>암호화폐 {displayValue(allocation.cryptoValueKrw)}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.label}>주요 보유 종목</Text>
              <Text style={styles.privateNote}>
                공개 범위상 주문/환전 내역은 제공되지 않고 포트폴리오 비중만 표시됩니다.
              </Text>
            </View>
          </>
        }
        ListEmptyComponent={
          <InlineEmptyState
            message="공개된 주요 보유 종목 정보가 없습니다."
          />
        }
        renderItem={({ item }) => (
          <View style={styles.positionRow}>
            <Text style={styles.symbol}>{item.symbol}</Text>
            <Text style={styles.weight}>{item.weight}%</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 24 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
    marginBottom: 12,
  },
  title: { fontSize: 22, fontWeight: '700' },
  label: { fontSize: 13, color: '#666' },
  helper: { fontSize: 14, color: '#444' },
  privateNote: { fontSize: 13, color: '#666', lineHeight: 20 },
  positionRow: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  symbol: { fontSize: 15, fontWeight: '700' },
  weight: { fontSize: 15, fontWeight: '700' },
});
