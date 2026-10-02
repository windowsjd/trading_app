import MarketSortControl from '../../features/market/MarketSortControl';
import { marketSortParams, nextMarketPage, type MarketSort, type MarketPageParam } from '../../features/market/marketSort';
import { semantic } from '../../theme/tokens';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { getMarketSessionLabel } from '../../features/market/marketPresentation';
import { useAdminDiagnostics } from '../../features/auth/useAdminDiagnostics';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  ActivityIndicator,
  Platform,
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import { useInfiniteQuery } from '@tanstack/react-query';

import type { MarketScreenProps } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { buildWsUrl } from '../../constants/env';
import {
  getAssets,
  type AssetType,
  type MarketAssetItemDto,
} from '../../features/market/api';
import { MarketAssetRow } from '../../features/market/MarketAssetRow';
import { useMarketTickers } from '../../features/market/useMarketTickers';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';

type Props = MarketScreenProps;

const TABS: Array<{ key: AssetType; label: string }> = [
  { key: 'domestic_stock', label: '국내 주식' },
  { key: 'us_stock', label: '미국 주식' },
  { key: 'crypto', label: '암호화폐' },
];

const CRYPTO_PRICE_BASIS_TEXT = '가격 기준: Binance Spot 최근 체결가';

export default function MarketScreen({ navigation }: Props) {
  const isAdmin = useAdminDiagnostics();
  const [selectedTab, setSelectedTab] = useState<AssetType>('domestic_stock');
  const [sort, setSort] = useState<MarketSort>('volume_desc');
  const sortParams = marketSortParams(sort);
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);

  const marketQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.market.assets({
      ...sortParams,
      assetType: selectedTab,
      withPrice: true,
      limit: 20,
      offset: 0,
    }),
    queryFn: ({ pageParam }) =>
      getAssets({
        ...sortParams,
        sortSnapshot: pageParam.sortSnapshot,
        assetType: selectedTab,
        withPrice: true,
        offset: pageParam.offset,
        limit: 20,
      }),
    getNextPageParam: nextMarketPage,
    initialPageParam: { offset: 0 } as MarketPageParam,
  });

  // REST is the baseline and stays untouched: rows receive their ticker as a
  // separate prop and merge it themselves, so one asset's tick never rebuilds
  // the other rows' data.
  const items = useMemo(() => {
    const byId = new Map<string, MarketAssetItemDto>();

    marketQuery.data?.pages.forEach((page) => {
      page.assets.forEach((item) => {
        byId.set(item.id, item);
      });
    });

    return Array.from(byId.values());
  }, [marketQuery.data]);

  const assetIds = useMemo(() => items.map((item) => item.id), [items]);
  const priceErrorsByAssetId = useMemo(
    () => new Map(
      marketQuery.data?.pages
        .flatMap((page) => page.priceErrors ?? [])
        .map((error) => [error.assetId, error] as const) ?? [],
    ),
    [marketQuery.data],
  );

  // Live overlay: the currently loaded rows subscribe on the app's shared
  // socket. Changing tab releases the previous tab's rows; loading another page
  // only adds the new ids.
  const { tickersByAssetId, showReconnectBanner, staleAssetIds } =
    useMarketTickers({
      assetIds,
      wsUrl: wsUrl ?? '',
      enabled: !!wsUrl,
    });

  const openAsset = useCallback(
    (assetId: string) => navigation.navigate('AssetDetail', { assetId }),
    [navigation],
  );

  const viewState = useMemo(() => {
    if (marketQuery.isLoading) return 'market_loading';
    if (marketQuery.isError && !marketQuery.data) return 'market_error';
    if (!items.length) return 'market_empty';
    return 'market_ready';
  }, [marketQuery.isLoading, marketQuery.isError, marketQuery.data, items.length]);

  if (viewState === 'market_loading') {
    return <FullPageLoading message="종목 목록을 불러오는 중입니다." />;
  }

  if (viewState === 'market_error') {
    return (
      <ErrorState
        title="종목 목록을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          void marketQuery.refetch();
        }}
        diagnosticError={marketQuery.error}
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
          if (marketQuery.hasNextPage && !marketQuery.isFetching && !marketQuery.isError) {
            void marketQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        refreshing={marketQuery.isRefetching}
        onRefresh={() => void marketQuery.refetch()}
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
                  <ActionPressable
                    key={tab.key}
                    testID={testID}
                    style={[styles.tabButton, active && styles.tabButtonActive]}
                    onPress={() => setSelectedTab(tab.key)}
                  >
                    <Text
                      style={active ? styles.tabTextActive : styles.tabText}
                    >
                      {tab.label}
                    </Text>
                  </ActionPressable>
                );
              })}
            </View>

            <ActionPressable
              style={styles.searchEntry}
              onPress={() => navigation.navigate('MarketSearch', { sort })}
            >
              <Text style={styles.searchEntryText}>종목명 또는 심볼 검색</Text>
            </ActionPressable>

            {selectedTab === 'crypto' ? (
              <Text style={styles.priceBasisText}>
                {CRYPTO_PRICE_BASIS_TEXT}
              </Text>
            ) : null}

            <Text testID="market-session-summary" style={styles.sessionSummary}>
              {getMarketSessionLabel(selectedTab, items, tickersByAssetId)}
            </Text>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
              <ActionPressable accessibilityRole="button" onPress={() => void marketQuery.refetch()} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}>
                <Text style={{ color: semantic.secondary, fontSize: 12 }}>새로고침</Text>
              </ActionPressable>
              <MarketSortControl value={sort} onChange={setSort} assetType={selectedTab} />
            </View>

            {/* One screen-level notice; rows never repeat a connection error. */}
            {isAdmin && showReconnectBanner ? (
              <View
                testID={TEST_IDS.market.reconnectBanner}
                style={styles.inlineWarning}
              >
                <Text style={styles.inlineWarningText}>
                  실시간 연결이 불안정합니다. 마지막 수신 가격을 표시하고
                  있습니다.
                </Text>
                <AdminDiagnosticPanel runtime={{
                  reconnecting: showReconnectBanner,
                  subscribedAssetCount: assetIds.length,
                }} />
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
          <MarketAssetRow
            item={item}
            ticker={tickersByAssetId.get(item.id) ?? null}
            isStale={staleAssetIds.has(item.id)}
            priceError={priceErrorsByAssetId.get(item.id)}
            onPress={openAsset}
          />
        )}
        ListFooterComponent={
          marketQuery.isFetchNextPageError ? (
            <ActionPressable accessibilityRole="button" onPress={() => void marketQuery.refetch()} style={{ minHeight: 48, justifyContent: 'center' }}>
              <Text>목록을 새로고침해 계속 보기</Text>
            </ActionPressable>
          ) : marketQuery.isFetchingNextPage ? (
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
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, paddingBottom: 24 },
  headerSection: {
    padding: 12, borderRadius: 14,
    backgroundColor: semantic.surface, gap: 12, marginBottom: 12 },
  tabRow: { flexDirection: 'row', gap: 8 },
  tabButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: semantic.raised,
  },
  tabButtonActive: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  tabText: { color: semantic.text, fontWeight: '600', fontSize: 14,
    ...(Platform.OS === 'web' ? { maxWidth: '100%', textAlign: 'center' } as const : {}) },
  tabTextActive: { color: semantic.onAccent, fontWeight: '600',
    ...(Platform.OS === 'web' ? { maxWidth: '100%', textAlign: 'center' } as const : {}) },
  searchEntry: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: semantic.raised,
  },
  searchEntryText: {
    color: semantic.secondary,
    fontSize: 16,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: semantic.border,
  },
  itemSymbol: { fontSize: 16, fontWeight: '700' },
  itemPrice: { fontSize: 15, fontWeight: '600' },
  alignEnd: { alignItems: 'flex-end' },
  helper: { fontSize: 14, color: semantic.secondary },
  inlineWarning: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: semantic.warningSurface,
  },
  inlineWarningText: { fontSize: 13, color: semantic.warning },
  priceBasisText: { fontSize: 13, color: semantic.secondary },
  sessionSummary: { fontSize: 13, color: semantic.secondary, textAlign: 'right', marginTop: 4 },
  footerLoader: { paddingVertical: 16 },
});
