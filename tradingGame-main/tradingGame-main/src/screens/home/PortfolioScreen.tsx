import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  FlatList,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';

import type { PortfolioScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { TEST_IDS } from '../../constants/testIds';
import {
  getPortfolioOverview,
  getPortfolioPositions,
  getPortfolioEquity,
  type PortfolioAssetClass,
  type PortfolioRange,
} from '../../features/portfolio/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';

type Props = PortfolioScreenProps;

const POSITION_TABS: Array<{ key: PortfolioAssetClass; label: string }> = [
  { key: 'domestic_stock', label: '국내 주식' },
  { key: 'us_stock', label: '미국 주식' },
  { key: 'crypto', label: '암호화폐' },
];

const RANGE_TABS: Array<{ key: PortfolioRange; label: string }> = [
  { key: '1d', label: '1D' },
  { key: '7d', label: '7D' },
  { key: 'season', label: '시즌' },
];

export default function PortfolioScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const [assetClass, setAssetClass] =
    useState<PortfolioAssetClass>('domestic_stock');
  const [range, setRange] = useState<PortfolioRange>('season');

  const overviewQuery = useQuery({
    queryKey: ['portfolio', 'overview'],
    queryFn: getPortfolioOverview,
  });

  const positionsQuery = useQuery({
    queryKey: ['portfolio', 'positions', assetClass],
    queryFn: () => getPortfolioPositions(assetClass),
  });

  const equityQuery = useQuery({
    queryKey: ['portfolio', 'equity', range],
    queryFn: () => getPortfolioEquity(range),
  });

  const viewState = useMemo(() => {
    if (overviewQuery.isLoading || positionsQuery.isLoading || equityQuery.isLoading) {
      return 'portfolio_loading';
    }

    if (!overviewQuery.data || !positionsQuery.data || !equityQuery.data) {
      return 'portfolio_error';
    }

    return 'portfolio_ready';
  }, [
    overviewQuery.isLoading,
    positionsQuery.isLoading,
    equityQuery.isLoading,
    overviewQuery.data,
    positionsQuery.data,
    equityQuery.data,
  ]);

  if (viewState === 'portfolio_loading') {
    return <FullPageLoading message="포트폴리오를 불러오는 중입니다." />;
  }

  if (viewState === 'portfolio_error' || !overviewQuery.data || !positionsQuery.data || !equityQuery.data) {
    return (
      <ErrorState
        title="포트폴리오를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          overviewQuery.refetch();
          positionsQuery.refetch();
          equityQuery.refetch();
        }}
      />
    );
  }

  const overview = overviewQuery.data;
  const positions = positionsQuery.data.items;
  const equity = equityQuery.data.points;

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.portfolio.screen}
        data={positions}
        keyExtractor={(item) => item.assetId}
        contentContainerStyle={styles.content}
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
              <Text style={styles.helper}>현금 {overview.allocation.cashKrwValue}</Text>
              <Text style={styles.helper}>국내 {overview.allocation.domesticStockValueKrw}</Text>
              <Text style={styles.helper}>미국 {overview.allocation.usStockValueKrw}</Text>
              <Text style={styles.helper}>암호화폐 {overview.allocation.cryptoValueKrw}</Text>
            </View>

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

              {equityQuery.isFetching ? (
                <SectionSkeleton lines={5} />
              ) : equity.length ? (
                equity.slice(0, 8).map((point) => (
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

              <View style={styles.row}>
                {POSITION_TABS.map((tab) => {
                  const active = tab.key === assetClass;
                  return (
                    <Pressable
                      key={tab.key}
                      testID={TEST_IDS.portfolio.assetTab(tab.key)}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setAssetClass(tab.key)}
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
          <InlineEmptyState
            title="보유 포지션이 없습니다."
            message="해당 자산군의 보유 포지션이 없습니다."
          />
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
  footerActions: { marginTop: 12, gap: 10 },
});