import FuturesMarketList from './FuturesMarketList';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import MarketSortControl from '../../features/market/MarketSortControl';
import { marketSortParams, nextMarketPage, type MarketSort } from '../../features/market/marketSort';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle, SCREEN_SECTION_GAP } from '../../theme/screenLayout';
import { SafeAreaView } from '../../theme/safeArea';
import { getMarketSessionLabel } from '../../features/market/marketPresentation';
import { useAdminDiagnostics } from '../../features/auth/useAdminDiagnostics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
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

export default function MarketScreen({ navigation, route }: Props) {
  const isAdmin = useAdminDiagnostics();
  const [cryptoProduct, setCryptoProduct] = useState<'spot' | 'futures'>('spot');
  const [selectedTab, setSelectedTab] = useState<AssetType>(route?.params?.assetType ?? 'domestic_stock');
  // Consume each explicit navigation intent. Clearing it also lets a later
  // visit request the same category after the user has changed tabs manually.
  useEffect(() => {
    if (route?.params?.assetType) {
      setSelectedTab(route.params.assetType);
      navigation.setParams({ assetType: undefined });
    }
  }, [route?.params?.assetType, navigation]);
  const [sort, setSort] = useState<MarketSort>('turnover_desc');
  const futuresMarket = selectedTab === 'crypto' && cryptoProduct === 'futures';
  const sortParams = marketSortParams(sort);
  const refreshSort = useRef(false);
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
        sortRefresh: refreshSort.current && pageParam.offset === 0,
        assetType: selectedTab,
        withPrice: true,
        offset: pageParam.offset,
        limit: 20,
      }),
    getNextPageParam: nextMarketPage,
    initialPageParam: { offset: 0 },
    enabled: !futuresMarket,
  });

  const refresh = usePullToRefresh([marketQuery],
    () => { refreshSort.current = true; },
    () => { refreshSort.current = false; });

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
  const { tickersByAssetId, showReconnectBanner, staleAssetIds, subscriptionErrorAssetIds, runtime: tickerRuntime } =
    useMarketTickers({
      assetIds,
      wsUrl: wsUrl ?? '',
      enabled: !!wsUrl && !futuresMarket,
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

  if (!futuresMarket && viewState === 'market_loading') {
    return <FullPageLoading message="종목 목록을 불러오는 중입니다." />;
  }

  if (!futuresMarket && viewState === 'market_error') {
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
    <SafeAreaView edges={['left', 'right']} style={styles.container}>
      <FlatList
        testID={TEST_IDS.market.screen}
        data={futuresMarket ? [] : items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (!futuresMarket && marketQuery.hasNextPage && !marketQuery.isFetching && !marketQuery.isError) {
            void marketQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        refreshControl={refresh.refreshControl}
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
                    accessibilityRole="tab"
                    accessibilityLabel={tab.label}
                    accessibilityState={{ selected: active }}
                    aria-selected={active}
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

            {selectedTab === 'crypto' ? <View style={styles.tabRow}>
              {(['spot', 'futures'] as const).map(product => <ActionPressable key={product} testID={`crypto-product-${product}`} accessibilityRole="tab" accessibilityState={{ selected: cryptoProduct === product }} aria-selected={cryptoProduct === product} onPress={() => setCryptoProduct(product)} style={[styles.tabButton, cryptoProduct === product && styles.tabButtonActive]}><Text style={cryptoProduct === product ? styles.tabTextActive : styles.tabText}>{product === 'spot' ? '현물' : '선물'}</Text></ActionPressable>)}
            </View> : null}
            {futuresMarket ? <FuturesMarketList onSelect={(accountId, instrumentId) => navigation.navigate('Futures', { accountId, instrumentId })} /> : <>
            <ActionPressable
              style={styles.searchEntry}
              onPress={() => navigation.navigate('MarketSearch', { sort })}
            >
              <Text style={styles.searchEntryText}>종목명 또는 심볼 검색</Text>
            </ActionPressable>

            <View style={styles.toolbar}>
              <Text testID="market-session-summary" style={styles.sessionSummary}>
                {getMarketSessionLabel(selectedTab, items, tickersByAssetId)}
              </Text>
              <MarketSortControl value={sort} onChange={setSort} />
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
                <AdminDiagnosticPanel runtime={tickerRuntime} />
              </View>
            ) : null}
            {isAdmin && !showReconnectBanner && (staleAssetIds.size > 0 || subscriptionErrorAssetIds?.size > 0) ? (
              <AdminDiagnosticPanel runtime={tickerRuntime} />
            ) : null}
            </>}
          </View>
        }
        ListEmptyComponent={futuresMarket ? null :
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
          futuresMarket ? null : marketQuery.isFetchNextPageError ? (
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
  // FlatList rows keep their existing spacing; the header owns section gaps.
  content: { ...getHeaderScreenContentStyle(Platform.OS), gap: 0 },
  headerSection: {
    paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: semantic.surface, gap: SCREEN_SECTION_GAP, marginBottom: SCREEN_SECTION_GAP },
  tabRow: { flexDirection: 'row', gap: 8 },
  tabButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: semantic.raised,
  },
  tabButtonActive: { backgroundColor: semantic.secondaryActionSurface, borderColor: semantic.secondaryActionSurface },
  tabText: { color: semantic.text, fontWeight: '600', fontSize: 14,
    ...(Platform.OS === 'web' ? { maxWidth: '100%', textAlign: 'center' } as const : {}) },
  tabTextActive: { color: semantic.secondaryActionForeground, fontWeight: '600',
    ...(Platform.OS === 'web' ? { maxWidth: '100%', textAlign: 'center' } as const : {}) },
  searchEntry: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
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
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 8, rowGap: 0 },
  sessionSummary: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 12, lineHeight: 18, color: semantic.secondary },
  footerLoader: { paddingVertical: 16 },
});
