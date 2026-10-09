import { financial } from '../../theme/financialColors';
import { semantic } from '../../theme/tokens';
import { useAdminDiagnostics } from '../../features/auth/useAdminDiagnostics';
import React, { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { useHeaderHeight } from '@react-navigation/elements';
import { useIsFocused } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import Svg, { Path } from 'react-native-svg';
import { useAppearance } from '../../theme/appearance';
import type { OrderScreenProps } from '../../app/navigation/types';
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
import AccountHoldings from '../asset/AccountHoldings';
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
import OrderPanel from './OrderPanel';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { safeRuntimeCode } from '../../services/ws/runtimeDiagnostics';

export default function OrderScreen(props: OrderScreenProps) {
  const { assetId, accountId, side } = props.route.params;
  return <OrderTradingScreen key={`${assetId}:${accountId}:${side}`} {...props} />;
}

export function OrderTradingScreen({
  route,
  navigation,
}: OrderScreenProps) {
  const { assetId, accountId, side } = route.params;
  const rootNavigation = useRootNavigation();
  const isFocused = useIsFocused();
  const isAdmin = useAdminDiagnostics();
  const headerHeight = useHeaderHeight();
  const inputScroll = useFocusedInputScroll();
  const { width } = useWindowDimensions();
  const { colors } = useAppearance();
  const compact = width < 600;
  const [showKrw, setShowKrw] = useState(false);
  const [attachedProtectionVisible, setAttachedProtectionVisible] = useState(false);
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const { accounts } = useTradingAccount();
  const account = accounts.find((item) => item.id === accountId) ?? null;
  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });
  const { latestTicker, connectionState, showReconnectBanner, isStale, runtime: tickerRuntime } =
    useAssetTicker({
      assetId,
      wsUrl: wsUrl ?? '',
      enabled: isFocused && !!wsUrl,
    });
  const liveOrderBookEnabled = supportsLiveOrderBook(detailQuery.data?.asset);
  const { latestOrderBook, statusMessage, runtime: orderBookRuntime } = useAssetOrderBook({
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
      {displayPrice.priceLocal === null || (converted && !krwAvailable) ? (
        <AdminDiagnosticPanel
          diagnostic={
            displayPrice.basis === 'realtime' ||
            displayPrice.basis === 'snapshot'
              ? undefined
              : detailQuery.data.priceErrors?.find(
                  (error) => error.assetId === assetId && error.diagnostic,
                )?.diagnostic
          }
          runtime={
            displayPrice.basis === 'realtime' ||
            displayPrice.basis === 'snapshot'
              ? {
                  assetId,
                  ...tickerRuntime,
                  connectionState,
                  tickerPriceAvailable: ticker?.priceLocal != null,
                  tickerReason: safeRuntimeCode(ticker?.reason) ?? 'not_observed',
                  priceKrwState: displayPrice.priceKrwState,
                  priceKrwReason: safeRuntimeCode(displayPrice.priceKrwReason) ?? 'not_observed',
                  priceCapturedAt: displayPrice.priceCapturedAt,
                }
              : null
          }
        />
      ) : null}
    </View>
  );
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.container}>
      <KeyboardAvoidingView
        style={styles.container}
        keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={inputScroll.scrollRef}
          style={styles.scroll}
          onLayout={inputScroll.revealFocusedInput}
          onContentSizeChange={inputScroll.revealFocusedInput}
          onScroll={inputScroll.onScroll}
          scrollEventThrottle={16}
          testID={TEST_IDS.order.screen}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
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
                    stroke={colors.secondary}
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
          {isAdmin && showReconnectBanner ? (
            <Text
              testID={TEST_IDS.assetDetail.reconnectBanner}
              style={styles.bannerText}
            >
              실시간 연결 복구 중 · 마지막 시세
            </Text>
          ) : null}
          {isAdmin && showReconnectBanner ? (
            <AdminDiagnosticPanel
              runtime={tickerRuntime}
            />
          ) : null}
          {isAdmin && isStale ? (
            <Text style={styles.bannerText}>
              실시간 시세 최신성이 낮습니다. 서버 견적에서 최종 확인됩니다.
            </Text>
          ) : null}
          {isAdmin && isStale ? (
            <AdminDiagnosticPanel
              runtime={tickerRuntime}
            />
          ) : null}
          <View style={[styles.tradingRow, compact && styles.compactTradingRow, compact && attachedProtectionVisible && styles.protectionTradingColumn]} testID="asset-trading-columns">
            <View style={styles.orderColumn} testID="asset-order-column">
              {account ? (
                <OrderPanel
                  key={`${assetId}:${accountId}:${side}`}
                  assetId={assetId}
                  accountId={accountId}
                  initialSide={side}
                  enabled={isFocused}
                  showAssetPriceDiagnostic={false}
                  onInputFocus={inputScroll.onInputFocus}
                  onInputBlur={inputScroll.onInputBlur}
                  submitRef={inputScroll.submitRef}
                  onAttachedProtectionVisibilityChange={setAttachedProtectionVisible}
                  onReturnToAsset={() => navigation.goBack()}
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
                <>
                  <AssetOrderLadder
                    book={latestOrderBook?.assetId === assetId ? latestOrderBook : null}
                    statusMessage={statusMessage}
                    currentPrice={currentPrice}
                  />
                  {isAdmin && statusMessage ? (
                    <AdminDiagnosticPanel runtime={orderBookRuntime} />
                  ) : null}
                </>
              ) : (
                <View style={styles.stockPrice}>{currentPrice}</View>
              )}
            </View>
          </View>
          <AccountHoldings
            onInputFocus={inputScroll.onInputFocus}
            onInputBlur={inputScroll.onInputBlur}
            isFocused={isFocused}
            key={accountId}
            accountId={accountId}
            account={account}
            assetId={assetId}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  scroll: { flex: 1 },
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
  pair: { fontSize: 20, fontWeight: '700', color: semantic.text },
  tools: { flexDirection: 'row', gap: 4, flexShrink: 0 },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    padding: 8,
    borderRadius: 8,
    backgroundColor: semantic.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleActive: { backgroundColor: semantic.selected },
  toggleText: { fontSize: 11, fontWeight: '700', color: semantic.secondary },
  toggleTextActive: { color: semantic.onAccent },
  muted: { opacity: 0.4 },
  subheader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  changeRate: { fontSize: 13, color: semantic.muted, fontVariant: ['tabular-nums'] },
  up: { color: financial.rise },
  down: { color: financial.fall },
  marketBadge: {
    fontSize: 11,
    color: semantic.muted,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: semantic.raised,
    borderRadius: 5,
  },
  tradingRow: {
    borderRadius: 12, paddingBottom: 14,
    backgroundColor: semantic.surface,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
    borderTopWidth: 1,
    borderColor: semantic.border,
    paddingTop: 14,
  },
  compactTradingRow: { gap: 6 },
  protectionTradingColumn: { flexDirection: 'column' },
  orderColumn: { flex: 1.15, minWidth: 0 },
  priceColumn: { flex: 1, minWidth: 0, overflow: 'hidden' },
  currentPrice: { paddingVertical: 14, gap: 4, minWidth: 0 },
  priceLabel: { fontSize: 11, color: semantic.muted },
  price: {
    fontSize: 19,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: semantic.text,
  },
  stockPrice: { flex: 1, justifyContent: 'center', minHeight: 280 },
  bannerText: { fontSize: 12, color: semantic.warning },
});
