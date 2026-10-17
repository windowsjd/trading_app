import { questGuideTarget, registerQuestGuideReveal } from '../../features/quest/questGuideBridge';
import { financial } from '../../theme/financialColors';
import { semantic } from '../../theme/tokens';
import { useAdminDiagnostics } from '../../features/auth/useAdminDiagnostics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
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
import { useAssetEstimatedQuote } from '../../features/asset/useAssetEstimatedQuote';
import AssetEstimatedQuoteCard from '../../features/asset/AssetEstimatedQuoteCard';
import {
  isTrialPriceSource,
  TRIAL_ORDER_NOTICE,
} from '../../features/asset/trialDataSource';
import { getLastSessionCloseLabel } from '../../features/asset/lastSessionClose';
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
import OrderAssetSheet from './OrderAssetSheet';
import { OrderAsideProvider, OrderAsideSlot } from './OrderAside';
import { fitPriceFontSize } from './stockOrderSummary';
import type { OrderSide } from './OrderSideSegment';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { safeRuntimeCode } from '../../services/ws/runtimeDiagnostics';

export default function OrderScreen(props: OrderScreenProps) {
  const { assetId, accountId, side } = props.route.params;
  const { navigation } = props;
  const [assetSheetOpen, setAssetSheetOpen] = useState(false);
  // The side the user is on now, so an asset change keeps the direction.
  const sideRef = useRef<OrderSide>(side ?? 'buy');
  const entryAssetId = useRef(assetId).current;
  useEffect(() => {
    sideRef.current = side ?? 'buy';
  }, [assetId, accountId, side]);
  const selectAsset = (nextAssetId: string) => {
    setAssetSheetOpen(false);
    if (nextAssetId === assetId) return;
    // Only the asset (and the current side) change. accountId stays the
    // route's bound account, and the new key remounts every order input,
    // quote and pending callback for the new asset.
    navigation.setParams({ assetId: nextAssetId, side: sideRef.current });
  };
  return (
    <>
      <OrderTradingScreen
        key={`${assetId}:${accountId}:${side}`}
        {...props}
        onOpenAssetSheet={() => setAssetSheetOpen(true)}
        // The stack's own detail page is the entry asset's; after an in-place
        // change, return to the detail of the asset being traded instead.
        onReturnToAsset={() => {
          if (assetId === entryAssetId) navigation.goBack();
          else navigation.popTo('AssetDetail', { assetId });
        }}
        onSideChange={(next) => {
          sideRef.current = next;
        }}
        onSelectAsset={selectAsset}
      />
      <OrderAssetSheet
        visible={assetSheetOpen}
        onClose={() => setAssetSheetOpen(false)}
        onSelect={selectAsset}
      />
    </>
  );
}

export function OrderTradingScreen({
  route,
  navigation,
  onOpenAssetSheet,
  onSideChange,
  onReturnToAsset,
  onSelectAsset,
}: OrderScreenProps & {
  onOpenAssetSheet?: () => void;
  onSideChange?: (side: OrderSide) => void;
  onReturnToAsset?: () => void;
  /** A holding row switches this order in place (same account, fresh inputs). */
  onSelectAsset?: (assetId: string) => void;
}) {
  const { assetId, accountId, side } = route.params;
  const rootNavigation = useRootNavigation();
  const isFocused = useIsFocused();
  const isAdmin = useAdminDiagnostics();
  const headerHeight = useHeaderHeight();
  const inputScroll = useFocusedInputScroll();
  const { revealView } = inputScroll;
  useEffect(() => { registerQuestGuideReveal('order', node => revealView(node, 'start')); return () => registerQuestGuideReveal('order', null); }, [revealView]);
  const { width, fontScale } = useWindowDimensions();
  const { colors } = useAppearance();
  const compact = width < 600;
  const [showKrw, setShowKrw] = useState(false);
  // The stock card's 시세 section (A-2): open by default, folded by the user.
  const [quoteOpen, setQuoteOpen] = useState(true);
  const [quoteWidth, setQuoteWidth] = useState(0);
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
  // US equities may have a provider's ESTIMATED best bid/ask (separate from
  // the order-book ladder). The server decides support; unsupported assets
  // answer UNSUPPORTED_ASSET and nothing is rendered.
  const estimatedQuoteEnabled =
    detailQuery.data?.asset.assetType === 'us_stock' &&
    detailQuery.data.asset.isActive;
  const {
    latestEstimate,
    supported: estimateSupported,
    statusMessage: estimateStatus,
    runtime: estimateRuntime,
  } = useAssetEstimatedQuote({
    assetId,
    wsUrl: wsUrl ?? '',
    enabled: estimatedQuoteEnabled && isFocused,
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
  // A closed US market's last confirmed close is labeled by its date, not 현재가.
  const lastCloseLabel =
    displayPrice.priceLocal === null ? null : getLastSessionCloseLabel(displayPrice);
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
  // Domestic and US stocks: the A-2 card (order inputs left; 시세, 내 보유 and
  // 예상 주문 right). Crypto keeps its form beside the live order book.
  const stock = asset.assetType === 'domestic_stock' || asset.assetType === 'us_stock';
  const changeDirection = Number(displayPrice.changeRate) > 0 ? 'up' : Number(displayPrice.changeRate) < 0 ? 'down' : null;
  const changeText = changeRate === '-'
    ? '-'
    : `${Number(displayPrice.changeRate) > 0 ? '+' : ''}${changeRate}%`;
  const priceDiagnostic = displayPrice.priceLocal === null || (converted && !krwAvailable) ? (
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
  ) : null;
  const currentPrice = (
    <View style={styles.currentPrice} testID="asset-current-price">
      <Text style={styles.priceLabel}>
        {lastCloseLabel ?? '현재가'} {converted ? 'KRW' : asset.priceCurrency}
      </Text>
      <Text style={styles.price} selectable>
        {priceText}
      </Text>
      {isTrialPriceSource(displayPrice.priceSource) ? (
        <Text testID="asset-trial-price-notice" style={styles.trialNotice}>
          {TRIAL_ORDER_NOTICE}
        </Text>
      ) : null}
      {priceDiagnostic}
    </View>
  );
  // The A-2 시세 section: current price, change (only the rate exists in the
  // price contract; no amount or day range is derived from it), US estimate.
  const stockQuote = stock ? (
    <View style={styles.stockQuote} testID="asset-current-price">
      <Text testID="order-price-label" style={styles.quoteLabel}>
        {lastCloseLabel ?? '현재가'} · {converted ? 'KRW' : asset.priceCurrency}
      </Text>
      <Text style={[styles.stockPriceText, { fontSize: fitPriceFontSize(priceText, quoteWidth, fontScale) }]} selectable>
        {priceText}
      </Text>
      <Text testID="order-change-rate" style={styles.changeLabel}
        accessibilityLabel={changeText === '-' ? '전일대비 정보 없음' : `전일대비 ${changeDirection === 'up' ? '상승 ' : changeDirection === 'down' ? '하락 ' : ''}${changeText}`}>
        전일대비{' '}
        <Text style={[styles.changeValue, changeDirection === 'up' ? styles.up : changeDirection === 'down' ? styles.down : null]}>
          {changeDirection === 'up' ? '▲ ' : changeDirection === 'down' ? '▼ ' : ''}{changeText}
        </Text>
      </Text>
      {priceDiagnostic}
    </View>
  ) : null;
  // Folding 시세 never hides what the order's amounts are based on.
  const trialNotice = isTrialPriceSource(displayPrice.priceSource) ? (
    <Text testID="asset-trial-price-notice" style={styles.trialNotice}>
      {TRIAL_ORDER_NOTICE}
    </Text>
  ) : null;
  const orderPanel = account ? (
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
      onSideChange={onSideChange}
      onReturnToAsset={onReturnToAsset ?? (() => navigation.goBack())}
    />
  ) : (
    <InlineEmptyState
      title="계정이 없습니다."
      message="계정을 개설하면 주문할 수 있습니다."
    />
  );
  const holdings = (
    <AccountHoldings
      onInputFocus={inputScroll.onInputFocus}
      onInputBlur={inputScroll.onInputBlur}
      isFocused={isFocused}
      key={accountId}
      accountId={accountId}
      account={account}
      assetId={assetId}
      onSelectAsset={onSelectAsset}
      currentInAside={stock}
    />
  );
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.container}>
      {/* Android draws edge to edge, so the keyboard no longer resizes the
          window (adjustResize): pad for it on both platforms. */}
      <KeyboardAvoidingView
        style={styles.container}
        keyboardVerticalOffset={headerHeight}
        behavior="padding"
      >
      <View ref={questGuideTarget('order-viewport')} collapsable={false} style={{ flex: 1 }}>
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
                accessibilityHint="종목 검색 창을 엽니다"
                onPress={() => onOpenAssetSheet?.()}
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
          {!stock ? <View style={styles.subheader}>
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
          </View> : null}
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
          {stock ? (
            <OrderAsideProvider>
              {/* A-2: one card, two columns at every width. The right column
                  shows 시세, then the holding and the expected order, which
                  AccountHoldings and the order form draw into its slots. */}
              <View style={[styles.stockCard, compact && styles.compactStockCard]} testID="asset-trading-columns">
                <View style={styles.stockOrderColumn} testID="asset-order-column">
                  {orderPanel}
                </View>
                <View style={styles.stockQuoteColumn} testID="asset-price-column"
                  onLayout={(event) => {
                    const next = Math.round(event.nativeEvent.layout.width);
                    setQuoteWidth((previous) => (previous === next ? previous : next));
                  }}>
                  <View style={styles.quoteHeader}>
                    <Text style={styles.quoteTitle} accessibilityRole="header">시세</Text>
                    <ActionPressable
                      testID="order-quote-toggle"
                      style={styles.quoteToggle}
                      accessibilityRole="button"
                      accessibilityLabel={quoteOpen ? '시세 접기' : '시세 펼치기'}
                      accessibilityState={{ expanded: quoteOpen }}
                      aria-expanded={quoteOpen}
                      onPress={() => setQuoteOpen((open) => !open)}
                    >
                      <Text style={styles.quoteToggleText}>{quoteOpen ? '접기' : '펼치기'}</Text>
                    </ActionPressable>
                  </View>
                  {quoteOpen ? (
                    <>
                      {stockQuote}
                      {estimateSupported ? (
                        <AssetEstimatedQuoteCard
                          estimate={
                            latestEstimate?.assetId === assetId
                              ? latestEstimate
                              : null
                          }
                          statusMessage={estimateStatus}
                          marketOpen={asset.marketStatus === 'open'}
                        />
                      ) : null}
                      {isAdmin && estimateSupported && estimateStatus ? (
                        <AdminDiagnosticPanel runtime={estimateRuntime} />
                      ) : null}
                    </>
                  ) : null}
                  {trialNotice}
                  <OrderAsideSlot name="holding" />
                  <OrderAsideSlot name="preview" />
                </View>
              </View>
              {holdings}
            </OrderAsideProvider>
          ) : (
            <>
              {/* The quote column stays beside the order inputs for every order type:
                  stacking it under a limit buy's TP/SL editor pushed the order book
                  below the whole form, so it looked gone. */}
              <View style={[styles.tradingRow, compact && styles.compactTradingRow]} testID="asset-trading-columns">
                <View style={styles.orderColumn} testID="asset-order-column">
                  {orderPanel}
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
                    <View style={styles.stockPrice}>
                      {currentPrice}
                      {estimateSupported ? (
                        <AssetEstimatedQuoteCard
                          estimate={
                            latestEstimate?.assetId === assetId
                              ? latestEstimate
                              : null
                          }
                          statusMessage={estimateStatus}
                          marketOpen={asset.marketStatus === 'open'}
                        />
                      ) : null}
                      {isAdmin && estimateSupported && estimateStatus ? (
                        <AdminDiagnosticPanel runtime={estimateRuntime} />
                      ) : null}
                    </View>
                  )}
                </View>
              </View>
              {holdings}
            </>
          )}
        </ScrollView>
      </View>
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
  // A-2 stock card: the inputs left, 시세/내 보유/예상 주문 right.
  stockCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
  },
  compactStockCard: { gap: 10, padding: 10 },
  stockOrderColumn: { flex: 1.2, minWidth: 0 },
  stockQuoteColumn: { flex: 1, minWidth: 0, gap: 12 },
  quoteHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 6,
    rowGap: 4,
    minHeight: 44,
  },
  quoteTitle: { flexShrink: 1, fontSize: 17, lineHeight: 24, fontWeight: '700', color: semantic.text },
  quoteToggle: {
    marginLeft: 'auto',
    minWidth: 44,
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: semantic.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quoteToggleText: { fontSize: 13, fontWeight: '600', color: semantic.secondary },
  stockQuote: { gap: 4, minWidth: 0 },
  quoteLabel: { fontSize: 12, color: semantic.muted },
  stockPriceText: {
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: semantic.text,
  },
  changeLabel: { fontSize: 12, lineHeight: 18, color: semantic.muted },
  changeValue: { fontSize: 13, fontWeight: '600', color: semantic.secondary, fontVariant: ['tabular-nums'] },
  bannerText: { fontSize: 12, color: semantic.warning },
  trialNotice: { fontSize: 10, color: semantic.warning },
});
