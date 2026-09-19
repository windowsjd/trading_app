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
import {
  findAccountPosition,
  getTradingAccountPositions,
} from '../../features/tradingAccount/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import { getPositionDisplay } from '../../features/position/display';
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
import SectionSkeleton from '../../components/states/SectionSkeleton';
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
  const headerHeight = useHeaderHeight();
  const [showKrw, setShowKrw] = useState(false);
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const { selectedAccountId, selectedAccount } = useTradingAccount();
  const accountId = selectedAccountId ?? '';
  const hasAccount = !!selectedAccountId;
  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });
  const positionQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.positions(accountId, {
      assetId,
      limit: 20,
    }),
    queryFn: () =>
      getTradingAccountPositions(accountId, { assetId, limit: 20, offset: 0 }),
    enabled: hasAccount,
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
  const position = findAccountPosition(positionQuery.data, assetId);
  const hasPosition = Number(position?.quantity ?? '0') > 0;
  const positionDisplay = position ? getPositionDisplay(position) : null;
  const accountDisplay = selectedAccount
    ? getAccountDisplay(selectedAccount)
    : null;
  const positionIntegrityMessage = positionQuery.isError
    ? getIntegrityErrorMessage(positionQuery.error)
    : null;
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
                ? '등락률 -'
                : `${Number(displayPrice.changeRate) > 0 ? '+' : ''}${changeRate}%`}
            </Text>
            {asset.assetType === 'domestic_stock' ? (
              <Text testID="asset-market-status" style={styles.marketBadge}>
                {getStockMarketStatus(asset.marketStatus)}
              </Text>
            ) : null}
          </View>
          {showReconnectBanner ? (
            <Text
              testID={TEST_IDS.assetDetail.reconnectBanner}
              style={styles.bannerText}
            >
              실시간 연결 복구 중 · 마지막 시세
            </Text>
          ) : null}
          {isStale ? (
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
          <View style={styles.card}>
            {/* WHICH account these holdings belong to is stated on the card
              itself: a quantity with no account next to it is not an answer to
              "do I own this" when the user holds several accounts. */}
            <Text style={styles.label}>
              내 포지션
              {accountDisplay ? ` · ${accountDisplay.title}` : ''}
            </Text>
            {accountDisplay ? (
              <Text style={styles.accountBadge}>
                {accountDisplay.statusLabel}
              </Text>
            ) : null}
            {!hasAccount ? (
              <InlineEmptyState
                title="계정이 없습니다."
                message="계정을 개설하면 보유 현황을 볼 수 있습니다."
              />
            ) : positionQuery.isLoading ? (
              <SectionSkeleton lines={4} />
            ) : positionIntegrityMessage ? (
              <>
                <InlineEmptyState
                  title="보유 내역을 안전하게 표시할 수 없습니다."
                  message={positionIntegrityMessage}
                />
                <ActionPressable
                  style={styles.retryButton}
                  onPress={() => void positionQuery.refetch()}
                >
                  <Text style={styles.retryText}>포지션 다시 시도</Text>
                </ActionPressable>
                <AdminDiagnosticPanel error={positionQuery.error} />
              </>
            ) : positionQuery.isError ? (
              <>
                <InlineEmptyState
                  title="포지션을 불러오지 못했습니다."
                  message="자산 정보는 계속 볼 수 있습니다."
                />
                <ActionPressable
                  style={styles.retryButton}
                  onPress={() => void positionQuery.refetch()}
                >
                  <Text style={styles.retryText}>포지션 다시 시도</Text>
                </ActionPressable>
                <AdminDiagnosticPanel error={positionQuery.error} />
              </>
            ) : hasPosition && position ? (
              <>
                <Text style={styles.helper}>
                  수량 {positionDisplay?.quantity ?? '-'}
                </Text>
                <Text style={styles.helper}>
                  평균단가 {positionDisplay?.averageCost ?? '-'}
                </Text>
                <Text style={styles.helper}>
                  현재가 {positionDisplay?.currentPrice ?? '시세 조회 불가'}
                </Text>
                <Text style={styles.helper}>
                  평가금액 {positionDisplay?.positionValueKrw ?? '-'}
                </Text>
                <Text style={styles.helper}>
                  평가손익 {positionDisplay?.unrealizedPnlKrw ?? '-'}
                </Text>
                <Text style={styles.helper}>
                  수익률 {positionDisplay?.returnRate ?? '-'}
                </Text>
                {positionDisplay?.priceNotice ? (
                  <Text style={styles.inlineWarningText}>
                    {positionDisplay.priceNotice}
                  </Text>
                ) : null}
              </>
            ) : (
              <InlineEmptyState
                title="보유 없음"
                message="아직 이 자산을 보유하고 있지 않습니다."
              />
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 32, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  pairButton: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' },
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
  card: {
    borderTopWidth: 1,
    borderColor: '#edf0f3',
    paddingTop: 16,
    gap: 8,
    marginTop: 8,
  },
  label: { fontSize: 13, color: '#697583' },
  helper: { fontSize: 14, color: '#536170' },
  accountBadge: {
    flexShrink: 0,
    alignSelf: 'flex-start',
    fontSize: 12,
    color: '#536170',
    backgroundColor: '#f2f5f7',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  retryButton: {
    alignSelf: 'flex-start',
    padding: 10,
    borderWidth: 1,
    borderColor: '#dfe4e9',
    borderRadius: 8,
  },
  retryText: { color: '#202a35' },
  inlineWarningText: { fontSize: 13, color: '#725400' },
  bannerText: { fontSize: 12, color: '#725400' },
});
