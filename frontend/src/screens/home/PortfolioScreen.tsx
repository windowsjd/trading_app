import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { PortfolioScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { TEST_IDS } from '../../constants/testIds';
import { QUERY_KEYS } from '../../constants/queryKeys';
import type { PortfolioViewState } from '../../models/enums/viewState';
import {
  getPortfolioOverview,
  getPortfolioPositions,
  getPortfolioEquity,
  type PortfolioAssetType,
  type PortfolioPositionItemDto,
  type PortfolioRange,
} from '../../features/portfolio/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import {
  DonutChart,
  LineChart,
  type DonutChartSegment,
  type LineChartPoint,
} from '../../components/charts';

type Props = PortfolioScreenProps;

const POSITION_TABS: Array<{ key: PortfolioAssetType; label: string }> = [
  { key: 'domestic_stock', label: '국내 주식' },
  { key: 'us_stock', label: '미국 주식' },
  { key: 'crypto', label: '암호화폐' },
];

const RANGE_TABS: Array<{ key: PortfolioRange; label: string }> = [
  { key: '1d', label: '1D' },
  { key: '7d', label: '7D' },
  { key: 'season', label: '시즌' },
];

const POSITIONS_PAGE_SIZE = 20;

function formatKrwChartValue(value: number) {
  return `${value.toFixed(0)} KRW`;
}

function getAllocationSegments(
  allocation: {
    cashKrwValue: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
  },
): DonutChartSegment[] {
  return [
    { key: 'cash', label: '현금', value: allocation.cashKrwValue },
    {
      key: 'domestic_stock',
      label: '국내 주식',
      value: allocation.domesticStockValueKrw,
    },
    { key: 'us_stock', label: '미국 주식', value: allocation.usStockValueKrw },
    { key: 'crypto', label: '암호화폐', value: allocation.cryptoValueKrw },
  ];
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

export default function PortfolioScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const [assetType, setAssetType] =
    useState<PortfolioAssetType>('domestic_stock');
  const [range, setRange] = useState<PortfolioRange>('season');

  const overviewQuery = useQuery({
    queryKey: QUERY_KEYS.portfolio.overview,
    queryFn: getPortfolioOverview,
  });

  const positionsQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.portfolio.positions({
      assetType,
      limit: POSITIONS_PAGE_SIZE,
      offset: 0,
    }),
    queryFn: ({ pageParam }) =>
      getPortfolioPositions({
        assetType,
        limit: POSITIONS_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
  });

  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.portfolio.equity(range),
    queryFn: () => getPortfolioEquity(range),
  });

  const positions = useMemo(() => {
    const byAssetId = new Map<string, PortfolioPositionItemDto>();

    positionsQuery.data?.pages.forEach((page) => {
      page.items.forEach((item) => {
        byAssetId.set(item.assetId, item);
      });
    });

    return Array.from(byAssetId.values());
  }, [positionsQuery.data]);

  const viewState = useMemo<PortfolioViewState>(() => {
    if (overviewQuery.isLoading) {
      return 'portfolio_loading';
    }

    if (overviewQuery.isError || !overviewQuery.data) {
      return 'portfolio_error';
    }

    if (positionsQuery.isSuccess && !positions.length) {
      return 'portfolio_no_positions';
    }

    if (positionsQuery.isError || equityQuery.isError) {
      return 'portfolio_partial_unavailable';
    }

    return 'portfolio_ready';
  }, [
    overviewQuery.isLoading,
    overviewQuery.isError,
    overviewQuery.data,
    positionsQuery.isError,
    positionsQuery.isSuccess,
    positions.length,
    equityQuery.isError,
  ]);

  if (viewState === 'portfolio_loading') {
    return <FullPageLoading message="포트폴리오를 불러오는 중입니다." />;
  }

  if (viewState === 'portfolio_error' || !overviewQuery.data) {
    return (
      <ErrorState
        title="포트폴리오를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          overviewQuery.refetch();
        }}
      />
    );
  }

  const overview = overviewQuery.data;
  const equity = equityQuery.data?.points ?? [];
  const allocationSegments = getAllocationSegments(overview.allocation);
  const equityChartPoints = getEquityChartPoints(equity);

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.portfolio.screen}
        data={positions}
        keyExtractor={(item) => item.assetId}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (positionsQuery.hasNextPage && !positionsQuery.isFetchingNextPage) {
            positionsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <>
            <View style={styles.card}>
              <Text style={styles.label}>총 자산</Text>
              <Text style={styles.big}>{overview.summary.totalAssetKrw} KRW</Text>
              <Text style={styles.helper}>수익률 {overview.summary.returnRate}%</Text>
              <Text style={styles.helper}>KRW {overview.summary.krwBalance}</Text>
              <Text style={styles.helper}>USD {overview.summary.usdBalance}</Text>
              <Text style={styles.helper}>USD 환산 KRW {overview.summary.usdBalanceKrw}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.label}>자산 비중</Text>
              <DonutChart
                segments={allocationSegments}
                valueFormatter={formatKrwChartValue}
                emptyMessage="자산 비중 데이터가 없습니다."
              />
            </View>

            {viewState === 'portfolio_partial_unavailable' ? (
              <View style={styles.inlineWarning}>
                <Text style={styles.inlineWarningText}>
                  일부 포트폴리오 정보를 불러오지 못했습니다.
                </Text>
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.label}>자산 추이</Text>

              <View style={styles.row}>
                {RANGE_TABS.map((tab) => {
                  const active = tab.key === range;
                  return (
                    <Pressable
                      key={tab.key}
                      testID={TEST_IDS.portfolio.equityRange(tab.key)}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setRange(tab.key)}
                    >
                      <Text style={active ? styles.chipTextActive : styles.chipText}>
                        {tab.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {equityQuery.isLoading ? (
                <SectionSkeleton lines={5} />
              ) : equityQuery.isError ? (
                <View style={styles.sectionFallback}>
                  <InlineEmptyState
                    title="자산 추이를 불러오지 못했습니다."
                    message="잠시 후 다시 시도해주세요."
                  />
                  <CTAButton
                    label="자산 추이 다시 불러오기"
                    onPress={() => equityQuery.refetch()}
                  />
                </View>
              ) : equity.length ? (
                <LineChart
                  points={equityChartPoints}
                  valueFormatter={formatKrwChartValue}
                  emptyMessage="자산 추이를 표시하려면 데이터가 더 필요합니다."
                />
              ) : (
                <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
              )}
            </View>

            <View style={styles.card}>
              <Text style={styles.label}>보유 포지션</Text>

              <View style={styles.row}>
                {POSITION_TABS.map((tab) => {
                  const active = tab.key === assetType;
                  return (
                    <Pressable
                      key={tab.key}
                      testID={TEST_IDS.portfolio.assetTab(tab.key)}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setAssetType(tab.key)}
                    >
                      <Text style={active ? styles.chipTextActive : styles.chipText}>
                        {tab.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </>
        }
        ListEmptyComponent={
          positionsQuery.isLoading ? (
            <SectionSkeleton lines={4} />
          ) : positionsQuery.isError ? (
            <View style={styles.sectionFallback}>
              <InlineEmptyState
                title="보유 포지션을 불러오지 못했습니다."
                message="잠시 후 다시 시도해주세요."
              />
              <CTAButton
                label="포지션 다시 불러오기"
                onPress={() => positionsQuery.refetch()}
              />
            </View>
          ) : viewState === 'portfolio_no_positions' ? (
            <InlineEmptyState
              title="보유 포지션이 없습니다."
              message="해당 자산군의 보유 포지션이 없습니다."
            />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            testID={TEST_IDS.portfolio.positionItem(item.assetId)}
            style={styles.positionRow}
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
              <Text style={styles.helper}>수량 {item.quantity}</Text>
            </View>

            <View style={styles.alignEnd}>
              <Text style={styles.itemTitle}>{item.marketValueKrw}</Text>
              <Text style={styles.helper}>{item.returnRate}%</Text>
              <Text style={styles.helper}>{item.unrealizedPnlKrw}</Text>
            </View>
          </Pressable>
        )}
        ListFooterComponent={
          <View style={styles.footerActions}>
            {positionsQuery.isFetchingNextPage ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator />
              </View>
            ) : null}
            <CTAButton
              label="마켓으로 이동"
              onPress={() =>
                rootNavigation.navigate('MainTabs', {
                  screen: 'MarketTab',
                  params: { screen: 'Market' },
                })
              }
            />
            <CTAButton
              label="뒤로가기"
              onPress={() => navigation.goBack()}
            />
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
    marginBottom: 12,
  },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  label: { fontSize: 13, color: '#666' },
  big: { fontSize: 24, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  inlineWarning: {
    borderWidth: 1,
    borderColor: '#f2d4a8',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#fff8ed',
    marginBottom: 12,
  },
  inlineWarningText: { color: '#7a4b00', fontWeight: '600' },
  sectionFallback: { gap: 10 },
  chip: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  chipActive: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  chipText: { color: '#111', fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '600' },
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
  itemTitle: { fontSize: 15, fontWeight: '700' },
  alignEnd: { alignItems: 'flex-end' },
  footerLoader: { paddingVertical: 16 },
  footerActions: { marginTop: 12, gap: 10 },
});
