import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import { questGuideTarget } from '../../features/quest/questGuideBridge';
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
  Platform,
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import SegmentedControl from '../../components/common/SegmentedControl';
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
import { useWatchlist, useWatchlistAssets } from '../../features/watchlist/useWatchlist';
import { WatchlistEmptyState, WatchlistErrorNotice } from '../../features/watchlist/WatchlistNotices';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import WhaleLoader from '../../components/states/WhaleLoader';

type Props = MarketScreenProps;

const TABS: Array<{ key: AssetType; label: string }> = [
  { key: 'domestic_stock', label: '국내 주식' },
  { key: 'us_stock', label: '미국 주식' },
  { key: 'crypto', label: '암호화폐' },
];

type ListScope = 'all' | 'watchlist';
const SCOPES: Array<{ key: ListScope; label: string; testID: string }> = [
  { key: 'all', label: '전체 종목', testID: TEST_IDS.market.scopeAll },
  { key: 'watchlist', label: '관심종목', testID: TEST_IDS.market.scopeWatchlist },
];
const NO_ASSETS: MarketAssetItemDto[] = [];

export default function MarketScreen({ navigation, route }: Props) {
  const isAdmin = useAdminDiagnostics();
  const guide = useQuestGuide();
  const [cryptoProduct, setCryptoProduct] = useState<'spot' | 'futures'>('spot');
  const [selectedTab, setSelectedTab] = useState<AssetType>(route?.params?.assetType ?? 'domestic_stock');
  // Consume each explicit navigation intent. Clearing it also lets a later
  // visit request the same category after the user has changed tabs manually.
  useEffect(() => {
    if (route?.params?.assetType) {
      setSelectedTab(route.params.assetType);
      setCryptoProduct('spot');
      navigation.setParams({ assetType: undefined });
    }
  }, [route?.params?.assetType, navigation]);
  const [sort, setSort] = useState<MarketSort>('turnover_desc');
  const [listScope, setListScope] = useState<ListScope>('all');
  const futuresMarket = selectedTab === 'crypto' && cryptoProduct === 'futures';
  // Spot only: the Futures list never shows or edits the Spot watchlist.
  const showWatchlist = listScope === 'watchlist' && !futuresMarket;
  useTradingGuideFacts({ screen: 'market', accountId: guide?.active?.accountId ?? '', assetType: selectedTab });
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

  const watchlist = useWatchlist();
  // The server's watched rows of this market — independent of how many market
  // pages are loaded, so an item outside the first 20 still appears.
  const watchlistAssets = useWatchlistAssets(selectedTab, showWatchlist);

  const refresh = usePullToRefresh(showWatchlist ? [watchlistAssets, watchlist.query] : [marketQuery, watchlist.query],
    () => { refreshSort.current = true; },
    () => { refreshSort.current = false; });

  // REST is the baseline and stays untouched: rows receive their ticker as a
  // separate prop and merge it themselves, so one asset's tick never rebuilds
  // the other rows' data.
  const marketItems = useMemo(() => {
    const byId = new Map<string, MarketAssetItemDto>();

    marketQuery.data?.pages.forEach((page) => {
      page.assets.forEach((item) => {
        byId.set(item.id, item);
      });
    });

    return Array.from(byId.values());
  }, [marketQuery.data]);
  const items = showWatchlist ? watchlistAssets.data?.assets ?? NO_ASSETS : marketItems;

  const assetIds = useMemo(() => items.map((item) => item.id), [items]);
  const priceErrorsByAssetId = useMemo(
    () => new Map(
      (showWatchlist
        ? watchlistAssets.data?.priceErrors ?? []
        : marketQuery.data?.pages.flatMap((page) => page.priceErrors ?? []) ?? [])
        .map((error) => [error.assetId, error] as const),
    ),
    [showWatchlist, watchlistAssets.data, marketQuery.data],
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
    if (!marketItems.length) return 'market_empty';
    return 'market_ready';
  }, [marketQuery.isLoading, marketQuery.isError, marketQuery.data, marketItems.length]);

  // The watchlist view keeps its own loading/error states below the header.
  if (!futuresMarket && !showWatchlist && viewState === 'market_loading') {
    return <FullPageLoading message="종목 목록을 불러오는 중입니다." />;
  }

  if (!futuresMarket && !showWatchlist && viewState === 'market_error') {
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
      <View ref={questGuideTarget('market-viewport')} collapsable={false} style={{ flex: 1 }}>
      <View ref={questGuideTarget('market-assets')} collapsable={false} style={{ flex: 1 }}><FlatList
        testID={TEST_IDS.market.screen}
        data={futuresMarket ? [] : items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (!futuresMarket && !showWatchlist && marketQuery.hasNextPage && !marketQuery.isFetching && !marketQuery.isError) {
            void marketQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        refreshControl={refresh.refreshControl}
        ListHeaderComponent={
          // The quest spotlight on the list starts below this header (spot rows only).
          <View ref={futuresMarket ? undefined : questGuideTarget('market-list-header')} collapsable={false} style={styles.headerSection}>
            <View ref={questGuideTarget('market-tabs')} collapsable={false}>
              <SegmentedControl testID="market-tabs" accessibilityLabel="시장 선택" value={selectedTab} onChange={setSelectedTab}
                options={TABS.map(tab => ({ key: tab.key, label: tab.label, testID: tab.key === 'domestic_stock'
                  ? TEST_IDS.market.tabDomestic : tab.key === 'us_stock' ? TEST_IDS.market.tabUs : TEST_IDS.market.tabCrypto }))} />
            </View>

            {selectedTab === 'crypto' ? (
              <SegmentedControl testID="crypto-product" accessibilityLabel="암호화폐 상품" value={cryptoProduct} onChange={setCryptoProduct}
                options={[
                  { key: 'spot', label: '현물', accessibilityLabel: '암호화폐 현물', testID: 'crypto-product-spot' },
                  { key: 'futures', label: '선물', accessibilityLabel: '암호화폐 선물', testID: 'crypto-product-futures' },
                ]} />
            ) : null}
            {futuresMarket ? <FuturesMarketList onSelect={(accountId, instrumentId) => navigation.navigate('Futures', { accountId, instrumentId })} /> : <>
            <ActionPressable
              style={styles.searchEntry}
              onPress={() => navigation.navigate('MarketSearch', { sort })}
            >
              <Text style={styles.searchEntryText}>종목명 또는 심볼 검색</Text>
            </ActionPressable>

            <SegmentedControl testID="market-scope" accessibilityLabel="목록 범위" compact value={listScope} onChange={setListScope}
              options={SCOPES} />

            <View style={styles.toolbar}>
              <Text testID="market-session-summary" style={styles.sessionSummary}>
                {getMarketSessionLabel(selectedTab, items, tickersByAssetId)}
              </Text>
              {/* Watchlist order is fixed: most recently added first. */}
              {showWatchlist
                ? <Text style={styles.orderCaption}>최근 추가한 순</Text>
                : <MarketSortControl value={sort} onChange={setSort} />}
            </View>

            {watchlist.query.isError && !watchlist.query.data ? (
              <WatchlistErrorNotice testID="watchlist-status-error" error={watchlist.query.error}
                message="관심종목 정보를 불러오지 못해 별 표시를 사용할 수 없습니다."
                onRetry={() => { void watchlist.query.refetch(); }} />
            ) : null}
            {showWatchlist && watchlistAssets.isError && watchlistAssets.data ? (
              <WatchlistErrorNotice testID="watchlist-refresh-error" error={watchlistAssets.error}
                message="관심종목을 새로 불러오지 못해 마지막으로 받은 목록을 표시합니다."
                onRetry={() => { void watchlistAssets.refetch(); }} />
            ) : null}

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
        ListEmptyComponent={futuresMarket ? null : showWatchlist ? (
          <WatchlistEmptyState
            isLoading={watchlistAssets.isLoading}
            isError={watchlistAssets.isError}
            error={watchlistAssets.error}
            onRetry={() => { void watchlistAssets.refetch(); }}
            marketLabel={TABS.find((tab) => tab.key === selectedTab)?.label ?? ''}
          />
        ) :
          <EmptyState
            title="표시할 종목이 없습니다."
            message="현재 조건에서 조회 가능한 종목이 없습니다."
          />
        }
        renderItem={({ item }) => {
          const watch = watchlist.watchStateOf(item.id);
          return (
            <MarketAssetRow
              item={item}
              ticker={tickersByAssetId.get(item.id) ?? null}
              isStale={staleAssetIds.has(item.id)}
              priceError={priceErrorsByAssetId.get(item.id)}
              onPress={openAsset}
              watched={watch.watched}
              watchPending={watch.pending}
              onWatchChange={watchlist.setWatched}
            />
          );
        }}
        ListFooterComponent={
          futuresMarket || showWatchlist ? null : marketQuery.isFetchNextPageError ? (
            <ActionPressable accessibilityRole="button" onPress={() => void marketQuery.refetch()} style={{ minHeight: 48, justifyContent: 'center' }}>
              <Text>목록을 새로고침해 계속 보기</Text>
            </ActionPressable>
          ) : marketQuery.isFetchingNextPage ? (
            <View style={styles.footerLoader}>
              <WhaleLoader size={28} />
            </View>
          ) : null
        }
      />
    </View>
      </View>
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
  orderCaption: { paddingVertical: 12, fontSize: 13, lineHeight: 20, color: semantic.secondary },
  footerLoader: { paddingVertical: 16 },
});
