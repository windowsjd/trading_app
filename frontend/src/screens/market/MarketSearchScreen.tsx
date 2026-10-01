import { semantic } from '../../theme/tokens';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { buildWsUrl } from '../../constants/env';
import { useMarketTickers } from '../../features/market/useMarketTickers';
import MarketAssetRow from '../../features/market/MarketAssetRow';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TextInput,
  FlatList,
  ActivityIndicator,
  Platform,
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import { useInfiniteQuery } from '@tanstack/react-query';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MarketStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getAssets,
  type AssetType,
  type MarketAssetItemDto,
} from '../../features/market/api';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';

type Props = NativeStackScreenProps<MarketStackParamList, 'MarketSearch'>;
type SearchScope = AssetType | 'all';

const SEARCH_SCOPE: Array<{ key: SearchScope; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'domestic_stock', label: '국내' },
  { key: 'us_stock', label: '미국' },
  { key: 'crypto', label: '암호화폐' },
];

export default function MarketSearchScreen({ navigation, route }: Props) {
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const [assetType, setAssetType] = useState<SearchScope>('all');
  const [searchText, setSearchText] = useState('');
  const trimmedSearchText = searchText.trim();

  const searchQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.market.assets({
      assetType: assetType === 'all' ? undefined : assetType,
      search: trimmedSearchText,
      withPrice: true,
      limit: 20,
      offset: 0,
    }),
    queryFn: ({ pageParam }) =>
      getAssets({
        assetType: assetType === 'all' ? undefined : assetType,
        search: trimmedSearchText || undefined,
        withPrice: true,
        offset: pageParam,
        limit: 20,
      }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
    enabled: trimmedSearchText.length > 0,
  });

  const items = useMemo(() => {
    const byId = new Map<string, MarketAssetItemDto>();

    searchQuery.data?.pages.forEach((page) => {
      page.assets.forEach((item) => {
        byId.set(item.id, item);
      });
    });

    return Array.from(byId.values());
  }, [searchQuery.data]);
  const assetIds = useMemo(() => items.map((item) => item.id), [items]);
  const { tickersByAssetId, staleAssetIds } = useMarketTickers({
    assetIds,
    wsUrl: wsUrl ?? '',
    enabled: !!wsUrl,
  });

  const openAsset = useCallback((assetId: string) => {
    if (route.params?.returnToAsset) navigation.popTo('AssetDetail', { assetId });
    else navigation.navigate('AssetDetail', { assetId });
  }, [navigation, route.params?.returnToAsset]);

  const hasPriceErrors = useMemo(
    () =>
      searchQuery.data?.pages.some(
        (page) => (page.priceErrors?.length ?? 0) > 0,
      ) ?? false,
    [searchQuery.data],
  );

  const viewState = useMemo(() => {
    if (!trimmedSearchText) return 'market_search_idle';
    if (searchQuery.isLoading) return 'market_search_loading';
    if (searchQuery.isError) return 'market_search_error';
    if (!items.length) return 'market_search_empty';
    return 'market_search_ready';
  }, [
    trimmedSearchText,
    searchQuery.isLoading,
    searchQuery.isError,
    items.length,
  ]);

  if (viewState === 'market_search_loading') {
    return <FullPageLoading message="검색 결과를 불러오는 중입니다." />;
  }

  if (viewState === 'market_search_error') {
    return (
      <ErrorState
        title="검색 결과를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => searchQuery.refetch()}
        diagnosticError={searchQuery.error}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (searchQuery.hasNextPage && !searchQuery.isFetchingNextPage) {
            searchQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.header}>
            <TextInput
              testID={TEST_IDS.market.searchInput}
              style={styles.searchInput}
              value={searchText}
              onChangeText={setSearchText}
              placeholder="종목명 또는 심볼 검색"
              autoCapitalize="characters"
            />

            <View style={styles.scopeRow}>
              {SEARCH_SCOPE.map((scope) => {
                const active = scope.key === assetType;
                return (
                  <ActionPressable
                    key={scope.key}
                    style={[styles.scopeChip, active && styles.scopeChipActive]}
                    onPress={() => setAssetType(scope.key)}
                  >
                    <Text
                      style={
                        active
                          ? styles.scopeChipTextActive
                          : styles.scopeChipText
                      }
                    >
                      {scope.label}
                    </Text>
                  </ActionPressable>
                );
              })}
            </View>

            {hasPriceErrors ? (
              <View style={styles.inlineWarning}>
                <Text style={styles.inlineWarningText}>
                  일부 검색 결과의 시세를 아직 불러오지 못했습니다.
                </Text>
                {searchQuery.data?.pages.flatMap((page) => page.priceErrors ?? [])
                  .map((error, index) => (
                    <AdminDiagnosticPanel
                      key={index}
                      diagnostic={error.diagnostic}
                    />
                  ))}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          viewState === 'market_search_idle' ? (
            <EmptyState
              title="검색어를 입력해주세요."
              message="종목명 또는 심볼로 검색할 수 있습니다."
            />
          ) : (
            <EmptyState
              title="검색 결과가 없습니다."
              message="다른 종목명 또는 심볼로 다시 검색해주세요."
            />
          )
        }
        renderItem={({ item }) => (
          <MarketAssetRow item={item} ticker={tickersByAssetId.get(item.id)}
            isStale={staleAssetIds.has(item.id)} onPress={openAsset} />
        )}
        ListFooterComponent={
          searchQuery.isFetchingNextPage ? (
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
  header: {
    padding: 12, borderRadius: 14,
    backgroundColor: semantic.surface, gap: 12, marginBottom: 12 },
  searchInput: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: semantic.input,
    fontSize: 16,
  },
  scopeRow: { flexDirection: 'row', gap: 8,
    ...(Platform.OS === 'web' ? { flexWrap: 'wrap' } as const : {}) },
  scopeChip: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: semantic.raised,
  },
  scopeChipActive: {
    backgroundColor: semantic.selected,
    borderColor: semantic.selected,
  },
  scopeChipText: { color: semantic.text, fontWeight: '600' },
  scopeChipTextActive: { color: semantic.onAccent, fontWeight: '600' },
  inlineWarning: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: semantic.warningSurface,
  },
  inlineWarningText: { fontSize: 13, color: semantic.warning },
  footerLoader: { paddingVertical: 16 },
});
