import React, { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getAssets, type AssetType } from '../../features/market/api';
import { marketSortParams } from '../../features/market/marketSort';
import { getMarketChangeDisplay, getMarketException } from '../../features/market/marketPresentation';
import { getAssetNameDisplay, getAssetPriceText, getAssetSymbolMarketDisplay } from '../../utils/format';
import ActionPressable from '../../components/common/ActionPressable';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';

const CATEGORIES: { key: AssetType; label: string }[] = [
  { key: 'domestic_stock', label: '국내주식' },
  { key: 'us_stock', label: '미국주식' },
  { key: 'crypto', label: '암호화폐' },
];

export function useHomeHotMarket(enabled: boolean) {
  const [assetType, setAssetType] = useState<AssetType>('domestic_stock');
  const refreshingCategory = useRef<AssetType | null>(null);
  const params = { ...marketSortParams('turnover_desc'), assetType, withPrice: true, limit: 5, offset: 0 };
  const query = useQuery({
    // Market uses an infinite shape. Keep its resource prefix, but never share
    // a single-page result with its pages/pageParams cache.
    queryKey: QUERY_KEYS.market.assetPreview(params),
    queryFn: () => getAssets({ ...params, sortRefresh: refreshingCategory.current === assetType }),
    enabled,
  });
  const refetch = async (options?: { cancelRefetch?: boolean }) => {
    refreshingCategory.current = assetType;
    try { return await query.refetch(options); }
    finally { refreshingCategory.current = null; }
  };
  return { assetType, setAssetType, query, refreshQuery: { ...query, refetch, enabled } };
}

export type HomeHotMarketData = ReturnType<typeof useHomeHotMarket>;

export default function HomeHotMarket({ hot, onOpenAsset, onOpenMarket }: {
  hot: HomeHotMarketData;
  onOpenAsset: (assetId: string) => void;
  onOpenMarket: (assetType: AssetType) => void;
}) {
  const { assetType, setAssetType, query } = hot;
  // The server sorts its whole universe before slicing. Only omit unusable
  // turnover evidence; never sort locally or fill the list from another page.
  const assets = query.data?.assets.filter(item => item.isActive && item.assetType === assetType &&
    typeof item.turnover === 'string' && /^\d+(\.\d+)?$/.test(item.turnover.trim())) ?? [];
  const category = CATEGORIES.find(item => item.key === assetType);
  return (
    <View testID="home-hot" style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>HOT 🔥</Text>
      <View style={styles.tabs}>
        {CATEGORIES.map(item => <ActionPressable key={item.key} testID={`home-hot-tab-${item.key}`}
          accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected: item.key === assetType }}
          aria-selected={item.key === assetType}
          onPress={() => setAssetType(item.key)} style={[styles.tab, item.key === assetType && styles.selectedTab]}>
          <Text style={[styles.tabText, item.key === assetType && styles.selectedText]}>{item.label}</Text>
        </ActionPressable>)}
      </View>
      <Text style={styles.caption}>거래대금 TOP 5</Text>
      {query.isLoading ? <SectionSkeleton lines={3} /> : null}
      {query.isError ? <ErrorState title="HOT 종목을 불러오지 못했습니다."
        onRetry={() => void hot.refreshQuery.refetch()} diagnosticError={query.error} /> : null}
      {!query.isLoading && !query.isError && !assets.length ? <InlineEmptyState message="거래대금을 확인할 수 있는 종목이 없습니다." /> : null}
      {assets.map((item, index) => {
        const name = getAssetNameDisplay(item).primary;
        const price = getAssetPriceText(item);
        const change = getMarketChangeDisplay(item);
        const exception = getMarketException(item);
        const priceError = query.data?.priceErrors?.find(error => error.assetId === item.id);
        return <View key={item.id}>
          <ActionPressable testID={`home-hot-item-${item.id}`} style={styles.row} accessibilityRole="button"
            accessibilityLabel={`${index + 1}위 ${name}, 현재가 ${price}, 등락률 ${change.text}`}
            onPress={() => onOpenAsset(item.id)}>
            <Text style={styles.rank}>{index + 1}</Text>
            <View style={styles.rowContent}>
              <View style={styles.identity}>
                <Text style={styles.name}>{name}</Text>
                <Text style={styles.caption}>{getAssetSymbolMarketDisplay(item)}</Text>
              </View>
              <View style={styles.values}>
                <Text style={styles.price}>{price}</Text>
                <Text testID={`home-hot-change-${item.id}`} style={[styles.change, { color: change.color }]}>{change.text}</Text>
                {exception ? <Text style={styles.exception}>{exception}</Text> : null}
              </View>
            </View>
          </ActionPressable>
          {priceError && item.price?.state !== 'available' ? <AdminDiagnosticPanel diagnostic={priceError.diagnostic} /> : null}
        </View>;
      })}
      <ActionPressable testID="home-hot-market" style={styles.marketAction} accessibilityRole="button"
        accessibilityLabel={`${category.label} 마켓으로 이동`} onPress={() => onOpenMarket(assetType)}>
        <Text style={styles.actionText}>마켓으로 이동 ›</Text>
      </ActionPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: semantic.border, borderRadius: 14, padding: 16, gap: 8, backgroundColor: semantic.surface },
  heading: { fontSize: 18, lineHeight: 27, fontWeight: '700' },
  tabs: { flexDirection: 'row', gap: 4, padding: 3, borderRadius: 10, backgroundColor: semantic.raised },
  tab: { flex: 1, minWidth: 0, minHeight: 44, paddingVertical: 8, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  selectedTab: { backgroundColor: semantic.secondaryActionSurface },
  tabText: { fontSize: 13, lineHeight: 20, fontWeight: '600', textAlign: 'center', maxWidth: '100%', color: semantic.secondary },
  selectedText: { color: semantic.secondaryActionForeground },
  caption: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  row: { flexDirection: 'row', gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: semantic.border, minHeight: 44 },
  rank: { fontSize: 14, lineHeight: 23, fontWeight: '700', color: semantic.secondary },
  rowContent: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' },
  identity: { flexGrow: 1, flexShrink: 1, flexBasis: 100, minWidth: 0 },
  name: { fontSize: 15, lineHeight: 23, fontWeight: '600' },
  values: { flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: '100%', alignItems: 'stretch' },
  price: { fontSize: 15, lineHeight: 23, fontWeight: '600', textAlign: 'right', fontVariant: ['tabular-nums'] },
  change: { fontSize: 13, lineHeight: 20, textAlign: 'right', fontVariant: ['tabular-nums'] },
  exception: { fontSize: 12, lineHeight: 18, textAlign: 'right', color: semantic.warning },
  marketAction: { minHeight: 44, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  actionText: { fontSize: 13, lineHeight: 20, color: semantic.secondary, fontWeight: '600' },
});
