import { useAdminDiagnostics } from '../../features/auth/useAdminDiagnostics';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
import { getTradingPair } from '../../features/asset/tradingHeader';
import { formatAssetPrice } from '../../utils/format';
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
  const { assetId } = route.params;
  const isFocused = useIsFocused();
  const isAdmin = useAdminDiagnostics();
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const [selectedTimeframe, setSelectedTimeframe] =
    useState<AssetChartTimeframe>(DEFAULT_ASSET_CHART_TIMEFRAME);
  const [chartHeight, setChartHeight] = useState(0);
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
  return (
    <SafeAreaView style={styles.screen} testID="asset-chart-screen">
      <View style={styles.header}>
        <ActionPressable
          testID="asset-chart-back"
          accessibilityRole="button"
          accessibilityLabel="차트 뒤로가기"
          style={styles.back}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backText}>←</Text>
        </ActionPressable>
        <View style={styles.heading}>
          <Text style={styles.title}>
            {asset ? getTradingPair(asset) : '차트'}
          </Text>
          <Text style={styles.price}>
            {formatAssetPrice(
              displayPrice.priceLocal,
              displayPrice.priceCurrency,
              displayPrice.displayPriceDecimals,
            )}
          </Text>
        </View>
      </View>
      <View style={styles.toolbar}>
        <ChartTimeframeSelector
          selectedTimeframe={selectedTimeframe}
          onSelect={setSelectedTimeframe}
        />
      </View>
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
      {isAdmin && candleLiveEnabled && isCandleStale ? (
        <Text style={styles.notice}>
          실시간 캔들 지연 · 최근 조회 데이터 표시
        </Text>
      ) : null}
      {candleLiveEnabled && latestCandle?.delayed ? (
        <Text style={styles.notice}>
          미국 캔들은 KIS 지연 체결 피드를 사용합니다.
        </Text>
      ) : null}
      <View
        style={styles.chart}
        onLayout={(event) =>
          setChartHeight(Math.floor(event.nativeEvent.layout.height))
        }
      >
        {candlesQuery.isLoading ? (
          <SectionSkeleton lines={8} />
        ) : candlesQuery.isError ? (
          <View style={styles.error}>
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
          </View>
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
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
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
  title: { fontSize: 18, fontWeight: '700', color: '#202a35' },
  price: { fontSize: 15, color: '#536170' },
  toolbar: { paddingHorizontal: 12, paddingBottom: 8 },
  chart: { flex: 1, minHeight: 0 },
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
