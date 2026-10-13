import React, { useMemo } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MarketStackParamList } from '../../app/navigation/types';
import { FlatList, Platform, StyleSheet, Text, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { getScreenContentStyle } from '../../theme/screenLayout';
import ActionPressable from '../../components/common/ActionPressable';
import EmptyState from '../../components/states/EmptyState';
import { useWatchlist } from '../../features/watchlist/useWatchlist';
import WatchlistButton from '../../features/watchlist/WatchlistButton';
import WatchlistNotice from '../../features/watchlist/WatchlistNotice';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';

type Props = NativeStackScreenProps<MarketStackParamList, 'Watchlist'>;
const LABELS = { domestic_stock: '국내 주식', us_stock: '미국 주식', crypto: '암호화폐 현물' };

export default function WatchlistScreen({ navigation, route }: Props) {
  const state = useWatchlist();
  const assetType = route.params.assetType;
  const items = useMemo(
    () => state.items?.filter((item) => item.assetType === assetType) ?? [],
    [state.items, assetType],
  );
  const refresh = usePullToRefresh([
    {
      refetch: state.refresh,
      isFetching: state.query.isFetching,
      enabled: state.ready || state.query.isError,
    },
  ]);
  return (
    <SafeAreaView edges={['left', 'right']} style={styles.container}>
      <FlatList
        testID="watchlist-list"
        data={items}
        keyExtractor={(item) => item.assetId}
        contentContainerStyle={getScreenContentStyle(Platform.OS)}
        refreshControl={refresh.refreshControl}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>{LABELS[assetType]} 관심종목</Text>
            <Text style={styles.helper}>최근 등록순 · 전체 {state.items?.length ?? '—'} / 50</Text>
            <WatchlistNotice state={state} />
          </View>
        }
        ListEmptyComponent={
          state.ready ? (
            <EmptyState
              title="등록된 관심종목이 없습니다."
              message="이 시장의 종목을 마켓이나 검색에서 등록해주세요."
            />
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <ActionPressable
              testID={`watchlist-item-${item.assetId}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${item.symbol}, ${item.market}, 종목 상세`}
              onPress={() => navigation.navigate('AssetDetail', { assetId: item.assetId })}
              style={styles.identity}
            >
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.helper}>
                {item.symbol} · {item.market}
              </Text>
              {!item.isActive ? <Text style={styles.inactive}>비활성 · 거래 불가</Text> : null}
            </ActionPressable>
            <WatchlistButton
              assetId={item.assetId}
              name={item.name}
              registered
              pending={state.pendingIds.has(item.assetId)}
              disabled={!state.ready}
              onChange={state.change}
            />
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  header: { padding: 12, gap: 8, marginBottom: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  row: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    backgroundColor: semantic.surface,
    borderColor: semantic.border,
    borderWidth: 1,
  },
  identity: { flex: 1, minWidth: 0, minHeight: 48, justifyContent: 'center', gap: 6 },
  name: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  helper: { fontSize: 14, color: semantic.secondary },
  inactive: { fontSize: 14, color: semantic.warning },
});
