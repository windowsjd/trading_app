import { useAdminDiagnostics } from '../../features/auth/useAdminDiagnostics';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { useIsFocused } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../app/navigation/types';
import {
  DEFAULT_ASSET_CHART_TIMEFRAME,
  getAssetCandles,
  getAssetDetail,
  type AssetChartTimeframe,
} from '../../features/asset/api';
import { useAssetCandle } from '../../features/asset/useAssetCandle';
import { useAssetTicker } from '../../features/asset/useAssetTicker';
import { applyTickerMarketState } from '../../features/asset/assetTickerPolicy';
import { selectDisplayPrice } from '../../features/asset/displayPricePolicy';
import { mergeAssetCandleSnapshot } from '../../features/asset/liveCandle';
import { describeCandleError } from '../../features/asset/candleErrors';
import {
  getStockMarketStatus,
  getTradingAssetName,
  getTradingPair,
} from '../../features/asset/tradingHeader';
import {
  formatAssetPrice,
  formatKrw,
  formatPercent,
  getAssetNameDisplay,
  getUnavailablePriceText,
} from '../../utils/format';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { buildWsUrl } from '../../constants/env';
import { CandlestickChart } from '../../components/charts';
import ChartTimeframeSelector from '../../components/charts/ChartTimeframeSelector';
import ActionPressable from '../../components/common/ActionPressable';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';

type Props = NativeStackScreenProps<RootStackParamList, 'AssetChart'>;
export default function AssetChartScreen(props: Props) {
  return <AssetChartContent key={props.route.params.assetId} {...props} />;
}

export function AssetChartContent({ route, navigation }: Props) {
  return (
    <AssetMarketChart
      assetId={route.params.assetId}
      onBack={() => navigation.goBack()}
    />
  );
}

type AssetMarketChartProps = {
  assetId: string;
  variant?: 'fullscreen' | 'detail';
  onBack?: () => void;
  onChangePair?: () => void;
};

export function AssetMarketChart({
  assetId,
  variant = 'fullscreen',
  onBack,
  onChangePair,
}: AssetMarketChartProps) {
  const isFocused = useIsFocused();
  const isAdmin = useAdminDiagnostics();
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const [selectedTimeframe, setSelectedTimeframe] =
    useState<AssetChartTimeframe>(DEFAULT_ASSET_CHART_TIMEFRAME);
  const [chartHeight, setChartHeight] = useState(0);
  const [displayCurrency, setDisplayCurrency] = useState<'USD' | 'KRW'>('USD');
  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
    enabled: isFocused,
  });
  const candlesQuery = useQuery({
    queryKey: QUERY_KEYS.asset.candles(assetId, {
      range: selectedTimeframe.range,
      interval: selectedTimeframe.interval,
      limit: selectedTimeframe.limit,
    }),
    queryFn: () =>
      getAssetCandles(assetId, {
        range: selectedTimeframe.range,
        interval: selectedTimeframe.interval,
        limit: selectedTimeframe.limit,
      }),
    enabled: isFocused,
  });
  const { latestTicker } = useAssetTicker({
    assetId,
    wsUrl: wsUrl ?? '',
    enabled: isFocused && !!wsUrl,
  });
  const {
    latestCandle,
    isStale: isCandleStale,
    resyncVersion: candleResyncVersion,
    liveEnabled: candleLiveEnabled,
  } = useAssetCandle({
    assetId,
    interval: selectedTimeframe.interval,
    wsUrl: wsUrl ?? '',
    enabled: isFocused && !!wsUrl,
  });
  const refetchCandles = candlesQuery.refetch;
  useEffect(() => {
    if (isFocused && candleResyncVersion > 0) void refetchCandles();
  }, [isFocused, candleResyncVersion, refetchCandles]);
  const ticker = latestTicker?.assetId === assetId ? latestTicker : null;
  const asset = detailQuery.data?.asset
    ? applyTickerMarketState(detailQuery.data.asset, ticker)
    : null;
  const displayPrice = selectDisplayPrice({
    latestTicker: ticker,
    restPrice: asset?.price,
    assetType: asset?.assetType,
    marketStatus: asset?.marketStatus,
    assetPriceCurrency: asset?.priceCurrency,
    assetDisplayPriceDecimals: asset?.displayPriceDecimals,
  });
  // Never overlay a previous asset/interval for the render before hook cleanup.
  const chartCandles = mergeAssetCandleSnapshot(
    candlesQuery.data,
    !isCandleStale &&
      latestCandle?.assetId === assetId &&
      latestCandle.interval === selectedTimeframe.interval
      ? latestCandle
      : null,
    selectedTimeframe.limit,
  );
  const detailView = variant === 'detail';
  const changeRate = formatPercent(displayPrice.changeRate);
  const usdAsset = displayPrice.priceCurrency === 'USD';
  const krwAvailable = displayPrice.priceKrwState === 'available' && displayPrice.priceKrw !== null;
  const usdPrice = formatAssetPrice(displayPrice.priceLocal, displayPrice.priceCurrency, displayPrice.displayPriceDecimals);
  const krwPrice = krwAvailable ? `${formatKrw(displayPrice.priceKrw)}원` : '원 환산 불가';
  const useKrw = usdAsset && krwAvailable && displayCurrency === 'KRW';
  const chartBody = (
    <>
      {detailView ? (
        <View style={styles.detailHeader}>
          <Text testID="asset-detail-name" style={styles.assetName}>
            {asset ? getAssetNameDisplay(asset).primary : '종목'}
          </Text>
          <ActionPressable
            testID="asset-change-pair"
            style={styles.symbolButton}
            accessibilityRole="button"
            accessibilityLabel={`종목 변경, ${asset ? getTradingPair(asset) : '종목'}`}
            onPress={onChangePair}
          >
            <Text style={styles.symbolText}>
              {asset ? (asset.assetType === 'crypto' ? getTradingAssetName(asset) : asset.symbol) : '종목 변경'} ▾
            </Text>
          </ActionPressable>
          <View style={styles.detailPriceRow}>
            <View style={styles.detailPriceStack}>
              <Text testID="asset-detail-primary-price" style={styles.detailPrice} selectable>
                {displayPrice.priceLocal === null && asset
                  ? getUnavailablePriceText(asset)
                  : useKrw ? krwPrice : usdPrice}
              </Text>
              {usdAsset ? (
                <Text testID="asset-detail-secondary-price" style={styles.secondaryPrice} selectable>
                  {useKrw ? usdPrice : krwPrice}
                </Text>
              ) : null}
            </View>
            {usdAsset ? (
              <View style={styles.currencyToggle} accessibilityRole="radiogroup">
                <ActionPressable testID="asset-currency-usd" accessibilityRole="radio"
                  accessibilityState={{ selected: !useKrw }}
                  style={[styles.currencyOption, !useKrw && styles.currencySelected]}
                  onPress={() => setDisplayCurrency('USD')}>
                  <Text style={[styles.currencyText, !useKrw && styles.currencySelectedText]}>$</Text>
                </ActionPressable>
                <ActionPressable testID="asset-currency-krw" accessibilityRole="radio"
                  accessibilityState={{ selected: useKrw, disabled: !krwAvailable }}
                  disabled={!krwAvailable}
                  style={[styles.currencyOption, useKrw && styles.currencySelected]}
                  onPress={() => setDisplayCurrency('KRW')}>
                  <Text style={[styles.currencyText, useKrw && styles.currencySelectedText]}>원</Text>
                </ActionPressable>
              </View>
            ) : null}
          </View>
          <View style={styles.marketInfo}>
            {asset && (asset.assetType === 'domestic_stock' || asset.assetType === 'us_stock') ? (
              <Text testID="asset-market-status" style={styles.marketBadge}>
                {getStockMarketStatus(asset.marketStatus)}
              </Text>
            ) : null}
            <Text testID="asset-change-rate" style={[styles.changeRate,
              Number(displayPrice.changeRate) > 0 ? styles.up : Number(displayPrice.changeRate) < 0 ? styles.down : null]}>
              {changeRate === '-' ? '전일대비 -'
                : `전일대비 ${Number(displayPrice.changeRate) > 0 ? '+' : ''}${changeRate}%`}
            </Text>
          </View>
          {isAdmin && usdAsset && !krwAvailable ? (
            <AdminDiagnosticPanel runtime={{ assetId, priceBasis: displayPrice.basis,
              priceKrwState: displayPrice.priceKrwState, priceKrwReason: displayPrice.priceKrwReason }} />
          ) : null}
        </View>
      ) : (
        <View style={styles.header}>
          <ActionPressable testID="asset-chart-back" accessibilityRole="button"
            accessibilityLabel="차트 뒤로가기" style={styles.back} onPress={onBack}>
            <Text style={styles.backText}>←</Text>
          </ActionPressable>
          <View style={styles.heading}>
            <Text style={styles.title}>{asset ? getTradingPair(asset) : '차트'}</Text>
            <Text style={styles.price} selectable>{usdPrice}</Text>
          </View>
        </View>
      )}
      {!detailView ? (
        <View style={styles.toolbar}>
          <ChartTimeframeSelector
            selectedTimeframe={selectedTimeframe}
            onSelect={setSelectedTimeframe}
          />
        </View>
      ) : null}
      {detailQuery.isError ? (
        <ActionPressable
          style={styles.retry}
          accessibilityRole="button"
          accessibilityLabel="종목 정보 다시 시도"
          onPress={() => void detailQuery.refetch()}
        >
          <Text style={styles.notice}>
            종목 정보를 불러오지 못했습니다. 다시 시도
          </Text>
        </ActionPressable>
      ) : null}
      {detailQuery.isError ? (
        <AdminDiagnosticPanel error={detailQuery.error} />
      ) : null}
      {isAdmin && candleLiveEnabled && isCandleStale ? (
        <Text style={styles.notice}>
          실시간 캔들 지연 · 최근 조회 데이터 표시
        </Text>
      ) : null}
      {isAdmin && candleLiveEnabled && isCandleStale ? (
        <AdminDiagnosticPanel
          runtime={{
            assetId,
            candleInterval: selectedTimeframe.interval,
            candleStale: isCandleStale,
            sourceUpdatedAt: latestCandle?.sourceUpdatedAt,
          }}
        />
      ) : null}
      {candleLiveEnabled && latestCandle?.delayed ? (
        <Text style={styles.notice}>
          미국 캔들은 KIS 지연 체결 피드를 사용합니다.
        </Text>
      ) : null}
      <View
        style={[styles.chart, detailView && styles.detailChart]}
        onLayout={(event) =>
          setChartHeight(Math.floor(event.nativeEvent.layout.height))
        }
      >
        {candlesQuery.isLoading ? (
          <SectionSkeleton lines={8} />
        ) : candlesQuery.isError ? (
          <ScrollView contentContainerStyle={styles.error}>
            <InlineEmptyState
              title={describeCandleError(candlesQuery.error).title}
              message={describeCandleError(candlesQuery.error).message}
            />
            <AdminDiagnosticPanel error={candlesQuery.error} />
            <ActionPressable
              testID={TEST_IDS.assetDetail.chartRetry}
              accessibilityRole="button"
              accessibilityLabel="차트 다시 시도"
              style={styles.retry}
              onPress={() => void candlesQuery.refetch()}
            >
              <Text>차트 다시 시도</Text>
            </ActionPressable>
          </ScrollView>
        ) : chartCandles.length ? (
          <CandlestickChart
            candles={chartCandles}
            height={chartHeight > 0 ? chartHeight : undefined}
            currencyCode={displayPrice.priceCurrency}
            displayPriceDecimals={displayPrice.displayPriceDecimals}
            currentPrice={
              displayPrice.isRealtime ? displayPrice.priceLocal : null
            }
            viewportResetKey={`${assetId}:${selectedTimeframe.interval}`}
          />
        ) : (
          <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
        )}
      </View>
      {detailView ? (
        <View style={styles.toolbar}>
          <ChartTimeframeSelector
            selectedTimeframe={selectedTimeframe}
            onSelect={setSelectedTimeframe}
          />
        </View>
      ) : null}
    </>
  );
  return detailView ? (
    <ScrollView style={styles.screen} contentContainerStyle={styles.detailContent}
      nestedScrollEnabled testID={TEST_IDS.assetDetail.screen}>
      {chartBody}
    </ScrollView>
  ) : (
    <SafeAreaView style={styles.screen} testID="asset-chart-screen">
      {chartBody}
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  detailContent: { flexGrow: 1 },
  detailHeader: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 6 },
  assetName: { fontSize: 28, fontWeight: '800', color: '#202a35', flexShrink: 1 },
  symbolButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center',
    backgroundColor: '#eef1f4', borderRadius: 8, paddingHorizontal: 10 },
  symbolText: { fontSize: 13, fontWeight: '600', color: '#536170' },
  detailPriceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    gap: 10, paddingTop: 8 },
  detailPriceStack: { flex: 1, minWidth: 0, gap: 2 },
  secondaryPrice: { fontSize: 14, color: '#697583', flexShrink: 1 },
  currencyToggle: { flexDirection: 'row', flexShrink: 0, borderRadius: 10,
    backgroundColor: '#eef1f4', padding: 3, gap: 2 },
  currencyOption: { minWidth: 44, minHeight: 44, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center' },
  currencySelected: { backgroundColor: '#fff' },
  currencyText: { fontSize: 15, fontWeight: '700', color: '#697583' },
  currencySelectedText: { color: '#202a35' },
  marketInfo: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingTop: 6 },
  detailPrice: {
    fontSize: 34,
    fontWeight: '700',
    color: '#202a35',
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  marketBadge: {
    alignSelf: 'flex-start',
    fontSize: 11,
    color: '#697583',
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#eef1f4',
    borderRadius: 5,
  },
  changeRate: { fontSize: 13, color: '#697583', flexShrink: 1 },
  up: { color: '#a13e3b' },
  down: { color: '#315f9b' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  back: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { fontSize: 26, color: '#202a35' },
  heading: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#202a35', flexShrink: 1 },
  price: { fontSize: 15, color: '#536170' },
  toolbar: { paddingHorizontal: 12, paddingBottom: 8 },
  chart: { flex: 1, minHeight: 0 },
  detailChart: { minHeight: 260 },
  notice: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    fontSize: 12,
    color: '#8b641e',
  },
  error: { padding: 16, gap: 12 },
  retry: {
    alignSelf: 'flex-start',
    padding: 12,
    borderWidth: 1,
    borderColor: '#dfe4e9',
    borderRadius: 8,
  },
});
