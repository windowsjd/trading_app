import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TextInput,
  FlatList,
  Pressable,
  ActivityIndicator,
} from 'react-native';
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

type Props = NativeStackScreenProps<MarketStackParamList, 'MarketSearch'>;
type SearchScope = AssetType | 'all';

const SEARCH_SCOPE: Array<{ key: SearchScope; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'domestic_stock', label: '국내' },
  { key: 'us_stock', label: '미국' },
  { key: 'crypto', label: '암호화폐' },
];

function getPriceText(item: MarketAssetItemDto) {
  if (item.price?.state !== 'available' || !item.price.currentPrice) {
    return '시세 준비 중';
  }

  return `${item.price.currentPrice} ${item.price.priceCurrency}`;
}

function getChangeRateText(item: MarketAssetItemDto) {
  if (item.price?.state !== 'available' || !item.price.changeRate) {
    return item.tradeBlockedReason ?? item.marketStatus;
  }

  return `${item.price.changeRate}%`;
}

export default function MarketSearchScreen({ navigation }: Props) {
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

  const hasPriceErrors = useMemo(
    () =>
      searchQuery.data?.pages.some((page) => (page.priceErrors?.length ?? 0) > 0) ??
      false,
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
                  <Pressable
                    key={scope.key}
                    style={[styles.scopeChip, active && styles.scopeChipActive]}
                    onPress={() => setAssetType(scope.key)}
                  >
                    <Text
                      style={active ? styles.scopeChipTextActive : styles.scopeChipText}
                    >
                      {scope.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {hasPriceErrors ? (
              <View style={styles.inlineWarning}>
                <Text style={styles.inlineWarningText}>
                  일부 검색 결과의 시세를 아직 불러오지 못했습니다.
                </Text>
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
          <Pressable
            testID={TEST_IDS.market.item(item.id)}
            style={styles.itemRow}
            onPress={() =>
              navigation.navigate('AssetDetail', { assetId: item.id })
            }
          >
            <View>
              <Text style={styles.itemSymbol}>{item.symbol}</Text>
              <Text style={styles.helper}>
                {item.name} · {item.market}
              </Text>
            </View>

            <View style={styles.alignEnd}>
              <Text style={styles.itemPrice}>{getPriceText(item)}</Text>
              <Text style={styles.helper}>{getChangeRateText(item)}</Text>
              <Text style={styles.helper}>
                {item.marketStatus} · {item.tradable ? '거래 가능' : '거래 제한'}
              </Text>
            </View>
          </Pressable>
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
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 24 },
  header: { gap: 12, marginBottom: 12 },
  searchInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#fff',
    fontSize: 16,
  },
  scopeRow: { flexDirection: 'row', gap: 8 },
  scopeChip: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  scopeChipActive: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  scopeChipText: { color: '#111', fontWeight: '600' },
  scopeChipTextActive: { color: '#fff', fontWeight: '600' },
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
