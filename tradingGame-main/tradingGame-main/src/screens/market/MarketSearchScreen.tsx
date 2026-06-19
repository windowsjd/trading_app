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
import { getAssets, type AssetClass } from '../../features/market/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';

type Props = NativeStackScreenProps<MarketStackParamList, 'MarketSearch'>;

const SEARCH_SCOPE: Array<{ key: AssetClass; label: string }> = [
  { key: 'domestic_stock', label: '국내' },
  { key: 'us_stock', label: '미국' },
  { key: 'crypto', label: '암호화폐' },
];

export default function MarketSearchScreen({ navigation }: Props) {
  const [assetClass, setAssetClass] = useState<AssetClass>('domestic_stock');
  const [searchText, setSearchText] = useState('');

  const searchQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.market.assets({
      assetClass,
      query: searchText,
      sort: 'volume',
      cursor: null,
    }),
    queryFn: ({ pageParam }) =>
      getAssets({
        assetClass,
        query: searchText || undefined,
        sort: 'volume',
        cursor: pageParam ?? null,
        limit: 20,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasNext ? lastPage.pageInfo.nextCursor : undefined,
    initialPageParam: null as string | null,
    enabled: searchText.trim().length > 0,
  });

  const items = useMemo(
    () => searchQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [searchQuery.data],
  );

  const viewState = useMemo(() => {
    if (!searchText.trim()) return 'market_search_idle';
    if (searchQuery.isLoading) return 'market_search_loading';
    if (searchQuery.isError) return 'market_search_error';
    if (!items.length) return 'market_search_empty';
    return 'market_search_ready';
  }, [searchText, searchQuery.isLoading, searchQuery.isError, items.length]);

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
                const active = scope.key === assetClass;
                return (
                  <Pressable
                    key={scope.key}
                    style={[styles.scopeChip, active && styles.scopeChipActive]}
                    onPress={() => setAssetClass(scope.key)}
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
              <Text style={styles.itemPrice}>
                {item.currentPrice} {item.priceCurrency}
              </Text>
              <Text style={styles.helper}>{item.changeRate}%</Text>
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
  footerLoader: { paddingVertical: 16 },
});