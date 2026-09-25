import { useAdminDiagnostics } from '../../features/auth/useAdminDiagnostics';
import React, { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { useIsFocused } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import Svg, { Path } from 'react-native-svg';
import type { AssetDetailScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { getAssetDetail } from '../../features/asset/api';
import { useAssetTicker } from '../../features/asset/useAssetTicker';
import { applyTickerMarketState } from '../../features/asset/assetTickerPolicy';
import { selectDisplayPrice } from '../../features/asset/displayPricePolicy';
import {
  getStockMarketStatus,
  getTradingPair,
} from '../../features/asset/tradingHeader';
import { supportsLiveOrderBook } from '../../features/asset/assetOrderBookPolicy';
import { useAssetOrderBook } from '../../features/asset/useAssetOrderBook';
import AssetOrderLadder from '../../features/asset/AssetOrderLadder';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import AccountHoldings from './AccountHoldings';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { buildWsUrl } from '../../constants/env';
import {
  formatAssetPrice,
  formatKrw,
  formatPercent,
  getUnavailablePriceText,
} from '../../utils/format';
import ActionPressable from '../../components/common/ActionPressable';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import OrderPanel from '../order/OrderPanel';

export default function AssetDetailScreen(props: AssetDetailScreenProps) {
  // No old ticker, KRW preference or order input survives a pair replacement.
  return <AssetTradingScreen key={props.route.params.assetId} {...props} />;
}

export function AssetTradingScreen({
  route,
  navigation,
}: AssetDetailScreenProps) {
  const { assetId } = route.params;
  const rootNavigation = useRootNavigation();
  const isFocused = useIsFocused();
  const isAdmin = useAdminDiagnostics();
  const headerHeight = useHeaderHeight();
  const [showKrw, setShowKrw] = useState(false);
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const { selectedAccountId, selectedAccount } = useTradingAccount();
  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });
  const { latestTicker, showReconnectBanner, isStale } = useAssetTicker({
    assetId,
    wsUrl: wsUrl ?? '',
    enabled: isFocused && !!wsUrl,
  });
  const liveOrderBookEnabled = supportsLiveOrderBook(detailQuery.data?.asset);
  const { latestOrderBook, statusMessage } = useAssetOrderBook({
    assetId,
    wsUrl: wsUrl ?? '',
    enabled: liveOrderBookEnabled && isFocused,
  });
  if (detailQuery.isLoading)
    return <FullPageLoading message="종목 정보를 불러오는 중입니다." />;
  if (detailQuery.isError || !detailQuery.data)
    return (
      <ErrorState
        title="종목 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void detailQuery.refetch()}
        diagnosticError={detailQuery.error}
      />
    );
  const ticker = latestTicker?.assetId === assetId ? latestTicker : null;
  const asset = applyTickerMarketState(detailQuery.data.asset, ticker);
  const displayPrice = selectDisplayPrice({
    latestTicker: ticker,
    assetType: asset.assetType,
    marketStatus: asset.marketStatus,
    restPrice: asset.price,
    assetPriceCurrency: asset.priceCurrency,
    assetDisplayPriceDecimals: asset.displayPriceDecimals,
  });
  const krwAvailable =
    displayPrice.priceKrwState === 'available' &&
    displayPrice.priceKrw !== null;
  const converted = showKrw && asset.priceCurrency !== 'KRW';
  const priceText = converted
    ? krwAvailable
      ? `₩${formatKrw(displayPrice.priceKrw)}`
      : '환산 불가'
    : displayPrice.priceLocal !== null
      ? formatAssetPrice(
          displayPrice.priceLocal,
          displayPrice.priceCurrency,
          displayPrice.displayPriceDecimals,
        )
      : getUnavailablePriceText(asset);
  const changeRate = formatPercent(displayPrice.changeRate);
  const pair = getTradingPair(asset);
  const currentPrice = (
    <View style={styles.currentPrice} testID="asset-current-price">
      <Text style={styles.priceLabel}>
        현재가 {converted ? 'KRW' : asset.priceCurrency}
      </Text>
      <Text style={styles.price} selectable>
        {priceText}
      </Text>
    </View>
  );
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.container}>
      <KeyboardAvoidingView
        style={styles.container}
        keyboardVerticalOffset={headerHeight}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          testID={TEST_IDS.assetDetail.screen}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <View style={styles.header}>
            <View style={styles.pairGroup} testID="asset-pair-header">
              <ActionPressable
                testID="asset-change-pair"
                style={styles.pairButton}
                accessibilityRole="button"
                accessibilityLabel={`종목 변경, ${pair}`}
                onPress={() =>
                  navigation.navigate('MarketSearch', { returnToAsset: true })
                }
              >
                <Text style={styles.pair}>{pair} ▾</Text>
              </ActionPressable>
              {asset.assetType === 'domestic_stock' ||
              asset.assetType === 'us_stock' ? (
                <Text testID="asset-market-status" style={styles.marketBadge}>
                  {getStockMarketStatus(asset.marketStatus)}
                </Text>
              ) : null}
            </View>
            <View style={styles.tools}>
              {asset.priceCurrency !== 'KRW' ? (
                <ActionPressable
                  testID="asset-krw-toggle"
                  style={[styles.iconButton, showKrw && styles.toggleActive]}
                  accessibilityRole="button"
                  accessibilityLabel="현재가 KRW 환산 표시"
                  accessibilityState={{
                    selected: showKrw,
                    disabled: !krwAvailable && !showKrw,
                  }}
                  disabled={!krwAvailable && !showKrw}
                  onPress={() => setShowKrw((value) => !value)}
                >
                  <Text
                    style={[
                      styles.toggleText,
                      showKrw && styles.toggleTextActive,
                      !krwAvailable && !showKrw && styles.muted,
                    ]}
                  >
                    KRW
                  </Text>
                </ActionPressable>
              ) : null}
              <ActionPressable
                testID="asset-open-chart"
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="전체화면 차트 열기"
                onPress={() =>
                  rootNavigation.navigate('AssetChart', { assetId })
                }
              >
                <Svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
                  <Path
                    d="M5 3v18M2 8h6v7H2zM12 2v17M9 5h6v8H9zM19 6v16M16 11h6v7h-6z"
                    fill="none"
                    stroke="#354251"
                    strokeWidth={1.5}
                  />
                </Svg>
              </ActionPressable>
            </View>
          </View>
          <View style={styles.subheader}>
            <Text
              style={[
                styles.changeRate,
                Number(displayPrice.changeRate) > 0
                  ? styles.up
                  : Number(displayPrice.changeRate) < 0
                    ? styles.down
                    : null,
              ]}
            >
              {changeRate === '-'
                ? '전일대비 -'
                : `전일대비 ${Number(displayPrice.changeRate) > 0 ? '+' : ''}${changeRate}%`}
            </Text>
          </View>
          <AdminDiagnosticPanel
            diagnostic={detailQuery.data.priceErrors?.find(
              (error) => error.assetId === assetId && error.diagnostic,
            )?.diagnostic}
          />
          {isAdmin && showReconnectBanner ? (
            <Text
              testID={TEST_IDS.assetDetail.reconnectBanner}
              style={styles.bannerText}
            >
              실시간 연결 복구 중 · 마지막 시세
            </Text>
          ) : null}
          {isAdmin && isStale ? (
            <Text style={styles.bannerText}>
              실시간 시세 최신성이 낮습니다. 서버 견적에서 최종 확인됩니다.
            </Text>
          ) : null}
          <View style={styles.tradingRow} testID="asset-trading-columns">
            <View style={styles.orderColumn} testID="asset-order-column">
              {selectedAccountId ? (
                <OrderPanel
                  key={`${assetId}:${selectedAccountId}`}
                  assetId={assetId}
                  accountId={selectedAccountId}
                  enabled={isFocused}
                  showAssetPriceDiagnostic={false}
                  onReturnToAsset={() => {}}
                />
              ) : (
                <InlineEmptyState
                  title="계정이 없습니다."
                  message="계정을 개설하면 주문할 수 있습니다."
                />
              )}
            </View>
            <View style={styles.priceColumn} testID="asset-price-column">
              {liveOrderBookEnabled ? (
                <AssetOrderLadder
                  book={
                    latestOrderBook?.assetId === assetId
                      ? latestOrderBook
                      : null
                  }
                  statusMessage={statusMessage}
                  currentPrice={currentPrice}
                />
              ) : (
                <View style={styles.stockPrice}>{currentPrice}</View>
              )}
            </View>
          </View>
          <AccountHoldings
            key={selectedAccountId ?? 'no-account'}
            accountId={selectedAccountId}
            account={selectedAccount}
            assetId={assetId}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 32, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  pairGroup: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 8,
  },
  pairButton: {
    flexShrink: 1,
    minWidth: 0,
    minHeight: 44,
    justifyContent: 'center',
  },
  pair: { fontSize: 20, fontWeight: '700', color: '#202a35' },
  tools: { flexDirection: 'row', gap: 4, flexShrink: 0 },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f2f5f7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleActive: { backgroundColor: '#202a35' },
  toggleText: { fontSize: 11, fontWeight: '700', color: '#536170' },
  toggleTextActive: { color: '#fff' },
  muted: { opacity: 0.4 },
  subheader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  changeRate: { fontSize: 13, color: '#697583', fontVariant: ['tabular-nums'] },
  up: { color: '#a13e3b' },
  down: { color: '#315f9b' },
  marketBadge: {
    fontSize: 11,
    color: '#697583',
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#eef1f4',
    borderRadius: 5,
  },
  tradingRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
    borderTopWidth: 1,
    borderColor: '#edf0f3',
    paddingTop: 14,
  },
  orderColumn: { flex: 1.15, minWidth: 0 },
  priceColumn: { flex: 1, minWidth: 0, overflow: 'hidden' },
  currentPrice: { paddingVertical: 14, gap: 4, minWidth: 0 },
  priceLabel: { fontSize: 11, color: '#7c8793' },
  price: {
    fontSize: 19,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: '#202a35',
  },
  stockPrice: { flex: 1, justifyContent: 'center', minHeight: 280 },
  bannerText: { fontSize: 12, color: '#725400' },
});
