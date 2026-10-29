import React from 'react';
import { Platform, SafeAreaView, ScrollView, StyleSheet, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import type { HomeScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { openInMarketTab } from '../../app/navigation/marketTabEntry';
import type { AssetType } from '../../features/market/api';
import { HomeGuestHero } from './HomeAssetHero';
import { HomeGuestHoldings } from './HomeHoldings';
import HomeHotMarket, { useHomeHotMarket } from './HomeHotMarket';

/**
 * Home in guest browsing (「로그인 없이 둘러보기」, 2026-10-30): the general
 * Home's layout, canvas, cards and scroll, with every account-scoped part
 * replaced by what signing in shows there. No account box, no asset trend,
 * no holdings read — the only request is HOT's account-free market list, and
 * no 「비회원으로 둘러보는 중」 banner is added on top.
 */
export default function GuestHomeScreen(_props: HomeScreenProps) {
  const rootNavigation = useRootNavigation();
  const { mode } = useAppearance();
  const hot = useHomeHotMarket(true);
  const refresh = usePullToRefresh([hot.refreshQuery]);

  const openAsset = (assetId: string) =>
    rootNavigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId, returnTab: 'HomeTab' }));
  const openMarket = (assetType: AssetType) =>
    rootNavigation.navigate('MainTabs', {
      screen: 'MarketTab', params: { screen: 'Market', params: { assetType } },
    });

  return (
    <SafeAreaView style={[styles.container, mode === 'light' && styles.lightCanvas]}>
      <View style={styles.body}>
        <ScrollView testID="guest-home" refreshControl={refresh.refreshControl} contentContainerStyle={styles.content}>
          <View style={styles.assetOverview}>
            <HomeGuestHero />
            <HomeGuestHoldings />
          </View>
          <HomeHotMarket hot={hot} onOpenAsset={openAsset} onOpenMarket={openMarket} />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

// Home's own frame (HomeScreen + GeneralAccountHome), unchanged.
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  lightCanvas: { backgroundColor: semantic.raised },
  body: { flex: 1 },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, gap: 12, paddingBottom: 24 },
  assetOverview: { gap: 4, minWidth: 0 },
});
