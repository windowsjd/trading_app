import { semantic } from '../../theme/tokens';
import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  RefreshControl,
} from '../../theme/native';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getRankingTier,
  getUserSeasonSummary,
} from '../../features/ranking/api';
import { formatKrw, formatPercent } from '../../utils/format';
import { getApiErrorCode } from '../../services/api/errorMapper';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';

type Props = { route: { params: { userId: string } } };
const assetLabels: Record<string, string> = {
  domestic_stock: '국내주식',
  us_stock: '미국주식',
  crypto: '암호화폐',
};
export default function UserSeasonSummaryScreen({ route }: Props) {
  const { userId } = route.params;
  const query = useQuery({
    queryKey: QUERY_KEYS.ranking.userSeasonSummary(userId),
    queryFn: ({ signal }) => getUserSeasonSummary(userId, signal),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  if (query.isLoading)
    return <FullPageLoading message="유저 정보를 불러오는 중입니다." />;
  const code = getApiErrorCode(query.error);
  if (code === 'USER_NOT_FOUND' || code === 'NOT_FOUND')
    return (
      <View style={styles.content}>
        <Text testID={TEST_IDS.userSummary.notFound}>
          해당 유저 정보를 찾을 수 없습니다.
        </Text>
      </View>
    );
  if (query.isError || !query.data)
    return (
      <ErrorState
        title="유저 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void refetch()}
      />
    );
  const { user, season, portfolioAccess, reason } = query.data;
  // Never paint cached sensitive sections while a fresh permission check runs.
  const portfolio =
    !query.isFetching && portfolioAccess === 'available'
      ? query.data.portfolio
      : null;
  const lockedMessage =
    portfolioAccess === 'private'
      ? '이 사용자는 포트폴리오를 비공개로 설정했습니다.'
      : portfolioAccess === 'not_friend'
        ? '친구 요청을 수락한 사용자만 포트폴리오를 볼 수 있습니다.'
        : !season
          ? '현재 시즌 정보가 없습니다.'
          : query.data.state === 'not_joined'
            ? '친구가 현재 시즌에 참가하지 않았습니다.'
            : reason === 'RANKING_HIDDEN' ||
                reason === 'PARTICIPANT_EXCLUDED'
              ? '이 사용자의 시즌 정보를 공개할 수 없습니다.'
              : '현재 시즌 포트폴리오를 이용할 수 없습니다.';
  return (
    <ScrollView
      testID={TEST_IDS.userSummary.screen}
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={() => void refetch()}
        />
      }
    >
      <View style={styles.card}>
        {user.profileImageUrl ? (
          <Image source={{ uri: user.profileImageUrl }} style={styles.avatar} />
        ) : null}
        <Text style={styles.title}>{user.nickname}</Text>
        <Text style={styles.helper}>
          {season?.name ?? '현재 시즌 정보가 없습니다.'}
        </Text>
        <Text style={styles.helper}>
          현재 순위 {season?.rank ? `#${season.rank}` : '-'}
        </Text>
        <Text style={styles.helper}>등급 {getRankingTier(season)}</Text>
      </View>
      {season ? (
        <View style={styles.card}>
          <Text style={styles.label}>현재 시즌 요약</Text>
          <Text style={styles.helper}>
            수익률 {formatPercent(season.returnRate)}%
          </Text>
          <Text style={styles.helper}>
            퍼센타일 {formatPercent(season.percentile)}%
          </Text>
          <Text style={styles.helper}>
            총 자산 {formatKrw(season.totalAssetKrw)}원
          </Text>
          <Text style={styles.helper}>
            최대 낙폭{' '}
            {season.maxDrawdown === null
              ? '-'
              : `${formatPercent(season.maxDrawdown)}%`}
          </Text>
        </View>
      ) : null}
      {portfolio ? (
        <>
          <View style={styles.card}>
            <Text style={styles.label}>자산 배분</Text>
            {portfolio.allocation ? (
              <>
                <Text style={styles.helper}>
                  현금 {formatKrw(portfolio.allocation.cashKrwValue)}원
                </Text>
                <Text style={styles.helper}>
                  국내주식{' '}
                  {formatKrw(portfolio.allocation.domesticStockValueKrw)}원
                </Text>
                <Text style={styles.helper}>
                  미국주식 {formatKrw(portfolio.allocation.usStockValueKrw)}원
                </Text>
                <Text style={styles.helper}>
                  암호화폐 {formatKrw(portfolio.allocation.cryptoValueKrw)}원
                </Text>
              </>
            ) : (
              <Text style={styles.helper}>
                일부 시세를 확인할 수 없어 자산 배분과 비중을 표시할 수
                없습니다.
              </Text>
            )}
          </View>
          <View style={styles.card}>
            <Text style={styles.label}>보유 종목</Text>
            {portfolio.holdings.length ? (
              portfolio.holdings.map((item) => (
                <View key={item.assetId} style={styles.row}>
                  <View style={styles.name}>
                    <Text style={styles.symbol}>{item.name}</Text>
                    <Text style={styles.helper}>
                      {item.symbol} ·{' '}
                      {assetLabels[item.assetType] ?? item.assetType}
                    </Text>
                  </View>
                  <Text style={styles.helper}>
                    {item.weight === null
                      ? '비중 확인 불가'
                      : `${formatPercent(item.weight)}%`}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.helper}>보유 종목이 없습니다.</Text>
            )}
          </View>
          <View style={styles.card}>
            <Text style={styles.label}>최근 30일 자산 / 수익률 추이</Text>
            {portfolio.history.length ? (
              portfolio.history.map((point) => (
                <View key={point.date} style={styles.historyRow}>
                  <Text style={styles.helper}>{point.date}</Text>
                  <Text style={styles.helper}>
                    {formatKrw(point.totalAssetKrw)}원 ·{' '}
                    {formatPercent(point.returnRate)}%
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.helper}>
                아직 일별 포트폴리오 기록이 없습니다.
              </Text>
            )}
          </View>
        </>
      ) : (
        <InlineEmptyState
          title={query.isFetching ? '공개 상태 확인 중' : '포트폴리오'}
          message={
            query.isFetching
              ? '최신 공개 설정을 확인하고 있습니다.'
              : lockedMessage
          }
        />
      )}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 10,
  },
  title: { fontSize: 22, fontWeight: '700', flexShrink: 1 },
  label: { fontSize: 17, fontWeight: '700' },
  helper: { fontSize: 14, color: semantic.secondary, flexShrink: 1 },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  name: { flexShrink: 1, minWidth: 0 },
  symbol: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  historyRow: { gap: 6, paddingVertical: 8 },
  avatar: { width: 56, height: 56, borderRadius: 28 },
});
