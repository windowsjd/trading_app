import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  Pressable,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';

import type { HomeScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { getHomeDashboard } from '../../features/home/api';
import { getCurrentSeason } from '../../features/season/api';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';

type Props = HomeScreenProps;

export default function HomeScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const homeQuery = useQuery({
    queryKey: QUERY_KEYS.home.dashboard,
    queryFn: getHomeDashboard,
    enabled: !!seasonQuery.data,
  });

  const season = seasonQuery.data;
  const home = homeQuery.data;

  const viewState = useMemo(() => {
    if (seasonQuery.isLoading || homeQuery.isLoading) return 'home_loading';
    if (!season) return 'home_error';

    if (season.status === 'active' && !season.joined) return 'home_active_not_joined';
    if (season.status === 'upcoming') return 'home_upcoming';
    if (season.status === 'ended') return 'home_ended_unsettled';
    if (season.status === 'settled') return 'home_settled';
    if (!home) return 'home_error';
    if (!home.topPositions.length) return 'home_no_positions';

    return 'home_active_joined';
  }, [seasonQuery.isLoading, homeQuery.isLoading, season, home]);

  const chartSectionError =
    viewState === 'home_active_joined' &&
    !!home &&
    !Array.isArray(home.equityChart);

  if (viewState === 'home_loading') {
    return <FullPageLoading message="홈 정보를 불러오는 중입니다." />;
  }

  if (viewState === 'home_error') {
    return (
      <ErrorState
        title="홈 정보를 불러오지 못했습니다."
        message="네트워크 또는 일시적 서버 오류일 수 있습니다."
        onRetry={() => {
          seasonQuery.refetch();
          homeQuery.refetch();
        }}
      />
    );
  }

  if (viewState === 'home_active_not_joined') {
    return (
      <BlockedState
        title="아직 이번 시즌에 참가하지 않았습니다."
        message="시즌에 참가해야 포트폴리오, 수익률, 거래 기능을 사용할 수 있습니다."
        actionLabel="시즌 참가하기"
        onAction={() => rootNavigation.navigate('SeasonJoin')}
      />
    );
  }

  if (viewState === 'home_upcoming') {
    return (
      <BlockedState
        title="시즌 시작 전입니다."
        message="시즌 시작 전에는 거래와 환전이 비활성입니다."
        actionLabel="시즌 안내 보기"
        onAction={() => rootNavigation.navigate('SeasonJoin')}
      />
    );
  }

  if (viewState === 'home_ended_unsettled') {
    return (
      <BlockedState
        title="시즌 정산 중입니다."
        message="정산 중에는 거래와 환전이 차단됩니다."
      />
    );
  }

  if (!home) return null;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.home.screen}
        contentContainerStyle={styles.content}
      >
        <View testID={TEST_IDS.home.summaryCard} style={styles.card}>
          <Text style={styles.label}>총 자산</Text>
          <Text style={styles.big}>{home.summary.totalAssetKrw} KRW</Text>
          <Text style={styles.helper}>수익률 {home.summary.returnRate}%</Text>
          <Text style={styles.helper}>KRW 잔액 {home.summary.krwBalance}</Text>
          <Text style={styles.helper}>USD 잔액 {home.summary.usdBalance}</Text>
        </View>

        <View style={styles.row}>
          <View style={[styles.card, styles.flex]}>
            <Text style={styles.label}>순위</Text>
            <Text style={styles.medium}>#{home.ranking.rank}</Text>
          </View>
          <View style={[styles.card, styles.flex]}>
            <Text style={styles.label}>등급</Text>
            <Text style={styles.medium}>{home.ranking.tier}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>자산 배분</Text>
          <Text style={styles.helper}>현금 {home.allocation.cashKrwValue}</Text>
          <Text style={styles.helper}>국내 {home.allocation.domesticStockValueKrw}</Text>
          <Text style={styles.helper}>미국 {home.allocation.usStockValueKrw}</Text>
          <Text style={styles.helper}>암호화폐 {home.allocation.cryptoValueKrw}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>자산 추이</Text>
          {chartSectionError ? (
            <>
              <SectionSkeleton lines={4} />
              <Pressable style={styles.retryButton} onPress={() => homeQuery.refetch()}>
                <Text style={styles.retryText}>차트 다시 시도</Text>
              </Pressable>
            </>
          ) : home.equityChart?.length ? (
            home.equityChart.slice(0, 8).map((point) => (
              <Text key={point.time} style={styles.helper}>
                {point.time} · {point.totalAssetKrw}
              </Text>
            ))
          ) : (
            <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>보유 포지션</Text>
          {viewState === 'home_no_positions' ? (
            <InlineEmptyState
              title="보유 포지션이 없습니다."
              message="현재는 현금 비중만 보유 중입니다."
            />
          ) : (
            home.topPositions.map((item) => (
              <Pressable
                key={item.assetId}
                testID={TEST_IDS.home.positionItem(item.assetId)}
                style={styles.itemRow}
                onPress={() =>
                  rootNavigation.navigate('MainTabs', {
                    screen: 'MarketTab',
                    params: {
                      screen: 'AssetDetail',
                      params: { assetId: item.assetId },
                    },
                  })
                }
              >
                <View>
                  <Text style={styles.itemTitle}>{item.symbol}</Text>
                  <Text style={styles.helper}>{item.name}</Text>
                </View>
                <View style={styles.alignEnd}>
                  <Text style={styles.itemTitle}>{item.marketValueKrw}</Text>
                  <Text style={styles.helper}>{item.returnRate}%</Text>
                </View>
              </Pressable>
            ))
          )}
        </View>

        <View style={styles.row}>
          <CTAButton
            label="환전하기"
            onPress={() => navigation.navigate('WalletFx')}
            style={styles.flex}
          />
          <CTAButton
            label="포트폴리오"
            onPress={() => navigation.navigate('Portfolio')}
            style={styles.flex}
          />
        </View>

        <View style={styles.row}>
          <CTAButton
            label="마켓으로 이동"
            onPress={() =>
              rootNavigation.navigate('MainTabs', {
                screen: 'MarketTab',
                params: { screen: 'Market' },
              })
            }
            style={styles.flex}
          />
          <CTAButton
            label="랭킹 보기"
            onPress={() =>
              rootNavigation.navigate('MainTabs', {
                screen: 'RankingTab',
                params: { screen: 'Ranking' },
              })
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
  row: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  label: { fontSize: 13, color: '#666' },
  big: { fontSize: 26, fontWeight: '700' },
  medium: { fontSize: 20, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingVertical: 10,
  },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  alignEnd: { alignItems: 'flex-end' },
  retryButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  retryText: { color: '#111', fontWeight: '600' },
});