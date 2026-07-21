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
import { useInfiniteQuery } from '@tanstack/react-query';

import type { MarketScreenProps } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getAssets,
  type AssetType,
  type MarketAssetItemDto,
} from '../../features/market/api';
import {
  formatPercent,
  getAssetNameDisplay,
  getAssetPriceText,
} from '../../utils/format';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';

type Props = MarketScreenProps;

const TABS: Array<{ key: AssetType; label: string }> = [
  { key: 'domestic_stock', label: '국내 주식' },
  { key: 'us_stock', label: '미국 주식' },
  { key: 'crypto', label: '암호화폐' },
];

function getChangeRateText(item: MarketAssetItemDto) {
  if (item.price?.state !== 'available' || !item.price.changeRate) {
    return item.tradeBlockedReason ?? item.marketStatus;
  }

  return `${formatPercent(item.price.changeRate)}%`;
}

export default function MarketScreen({ navigation }: Props) {
  const [selectedTab, setSelectedTab] = useState<AssetType>('domestic_stock');

  const marketQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.market.assets({
      assetType: selectedTab,
      withPrice: true,
      limit: 20,
      offset: 0,
    }),
    queryFn: ({ pageParam }) =>
      getAssets({
        assetType: selectedTab,
        withPrice: true,
        offset: pageParam,
        limit: 20,
      }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
  });

  const items = useMemo(() => {
    const byId = new Map<string, MarketAssetItemDto>();

    marketQuery.data?.pages.forEach((page) => {
      page.assets.forEach((item) => {
        byId.set(item.id, item);
      });
    });

    return Array.from(byId.values());
  }, [marketQuery.data]);

  const hasPriceErrors = useMemo(
    () =>
      marketQuery.data?.pages.some((page) => (page.priceErrors?.length ?? 0) > 0) ??
      false,
    [marketQuery.data],
  );

  const viewState = useMemo(() => {
    if (marketQuery.isLoading) return 'market_loading';
    if (marketQuery.isError) return 'market_error';
    if (!items.length) return 'market_empty';
    if (hasPriceErrors) return 'market_partial_price_unavailable';
    return 'market_ready';
  }, [marketQuery.isLoading, marketQuery.isError, items.length, hasPriceErrors]);

  if (viewState === 'market_loading') {
    return <FullPageLoading message="종목 목록을 불러오는 중입니다." />;
  }

  if (viewState === 'market_error') {
    return (
      <ErrorState
        title="종목 목록을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => marketQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.market.screen}
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (marketQuery.hasNextPage && !marketQuery.isFetchingNextPage) {
            marketQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.headerSection}>
            <View style={styles.tabRow}>
              {TABS.map((tab) => {
                const active = tab.key === selectedTab;
                const testID =
                  tab.key === 'domestic_stock'
                    ? TEST_IDS.market.tabDomestic
                    : tab.key === 'us_stock'
                    ? TEST_IDS.market.tabUs
                    : TEST_IDS.market.tabCrypto;

                return (
                  <Pressable
                    key={tab.key}
                    testID={testID}
                    style={[styles.tabButton, active && styles.tabButtonActive]}
                    onPress={() => setSelectedTab(tab.key)}
                  >
                    <Text style={active ? styles.tabTextActive : styles.tabText}>
                      {tab.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              style={styles.searchEntry}
              onPress={() => navigation.navigate('MarketSearch')}
            >
              <Text style={styles.searchEntryText}>종목명 또는 심볼 검색</Text>
            </Pressable>

            {viewState === 'market_partial_price_unavailable' ? (
              <View style={styles.inlineWarning}>
                <Text style={styles.inlineWarningText}>
                  일부 종목 시세를 아직 불러오지 못했습니다.
                </Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="표시할 종목이 없습니다."
            message="현재 조건에서 조회 가능한 종목이 없습니다."
          />
        }
        renderItem={({ item }) => (
          <Pressable
            testID={TEST_IDS.market.item(item.id)}
            style={styles.itemRow}
            onPress={() =>
              navigation.navigate('AssetDetail', { assetId: item.id })
            }
          >
            <View>
              <Text style={styles.itemSymbol}>{getAssetNameDisplay(item).primary}</Text>
              <Text style={styles.helper}>
                {item.symbol} · {item.market}
              </Text>
            </View>

            <View style={styles.alignEnd}>
              <Text style={styles.itemPrice}>{getAssetPriceText(item)}</Text>
              <Text style={styles.helper}>{getChangeRateText(item)}</Text>
              <Text style={styles.helper}>
                {item.marketStatus} · {item.tradable ? '거래 가능' : '거래 제한'}
              </Text>
            </View>
          </Pressable>
        )}
        ListFooterComponent={
          marketQuery.isFetchingNextPage ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 24 },
  headerSection: { gap: 12, marginBottom: 12 },
  tabRow: { flexDirection: 'row', gap: 8 },
  tabButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  tabButtonActive: { backgroundColor: '#111', borderColor: '#111' },
  tabText: { color: '#111', fontWeight: '600', fontSize: 14 },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  searchEntry: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#fff',
  },
  searchEntryText: {
    color: '#666',
    fontSize: 16,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  itemSymbol: { fontSize: 16, fontWeight: '700' },
  itemPrice: { fontSize: 15, fontWeight: '600' },
  alignEnd: { alignItems: 'flex-end' },
  helper: { fontSize: 14, color: '#444' },
  inlineWarning: {
    borderWidth: 1,
    borderColor: '#F2D48B',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FFF8E1',
  },
  inlineWarningText: { fontSize: 13, color: '#725400' },
  footerLoader: { paddingVertical: 16 },
});
