import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CandlestickChart from '../../components/charts/CandlestickChart';
import ChartLoading from '../../components/charts/ChartLoading';
import ChartTimeframeSelector from '../../components/charts/ChartTimeframeSelector';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import { QUERY_KEYS } from '../../constants/queryKeys';
import type { AssetChartTimeframe } from '../../features/asset/chartTimeframes';
import {
  FUTURES_CHART_REFRESH_MS,
  futuresChartWindow,
  getFuturesInstrumentCandles,
} from '../../features/futures/api';

/** Never below the old inline strip; with less room the screen scrolls. */
export const FUTURES_CHART_MIN_HEIGHT = 280;
/** The detail screen's chart floor (the asset detail chart's). */
export const FUTURES_DETAIL_CHART_MIN_HEIGHT = 260;

type Props = {
  instrumentId: string;
  displayPriceDecimals: number | null;
  /** Fresh Futures Last only; null hides the current-price line. */
  currentPrice: string | null;
  /** The selected 봉 시간 (the shared chart timeframe list). */
  timeframe: AssetChartTimeframe;
  onTimeframeChange: (timeframe: AssetChartTimeframe) => void;
  /**
   * detail: the asset detail's layout — the chart, then the 봉 시간 selector
   * under its left edge. fullscreen: the selector above a chart that takes
   * the rest of the screen (AssetChart's full-screen variant).
   */
  variant?: 'detail' | 'fullscreen';
};

/**
 * The chart of ONE futures contract (Binance USDⓈ-M contract trade price;
 * never Mark, Index or a Spot price) at the selected 봉 시간. Each contract and
 * 봉 시간 is its own query (account-free market data), so a response for an
 * earlier choice can never be drawn under the current one: a 봉 시간 without
 * candles yet shows the whale, a cached one draws at once and refreshes
 * behind the chart, and the viewport resets per contract and 봉 시간. The last
 * candle may be the bucket still in progress (the server marks it; nothing is
 * filled in or synthesized here). Mounted with `key={instrumentId}` by the
 * screens, so a contract switch never shows the previous contract's candles.
 */
export default function FuturesCandleChart({
  instrumentId,
  displayPriceDecimals,
  currentPrice,
  timeframe,
  onTimeframeChange,
  variant = 'fullscreen',
}: Props) {
  const focused = useIsFocused();
  const [chartHeight, setChartHeight] = useState(0);
  const window = futuresChartWindow(timeframe.interval);
  const candles = useQuery({
    queryKey: QUERY_KEYS.futuresMarket.candles(instrumentId, window),
    queryFn: ({ signal }) => getFuturesInstrumentCandles(instrumentId, window, signal),
    enabled: focused,
    refetchInterval: focused ? FUTURES_CHART_REFRESH_MS[window.interval] : false,
    retry: false,
  });
  const data =
    candles.data?.instrument.id === instrumentId &&
    candles.data.interval === window.interval
      ? candles.data
      : undefined;
  const chartCandles = useMemo(
    () =>
      (data?.candles ?? []).map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })),
    [data],
  );
  const detail = variant === 'detail';
  const selector = (
    <View style={styles.toolbar}>
      <ChartTimeframeSelector selectedTimeframe={timeframe} onSelect={onTimeframeChange} />
    </View>
  );

  return (
    <View testID="futures-candle-chart" style={detail ? styles.detailBox : styles.box}>
      {detail ? null : selector}
      {data?.source.stale ? (
        // The server could not refresh this copy; the live Last stays separate.
        <Text testID="futures-chart-stale" style={styles.notice}>
          차트 갱신이 지연되고 있습니다.
        </Text>
      ) : null}
      <View
        style={detail ? styles.detailChart : styles.chart}
        onLayout={(event) =>
          setChartHeight(Math.floor(event.nativeEvent.layout.height))
        }
      >
        {candles.isPending ? (
          <ChartLoading />
        ) : candles.isError && !data ? (
          <View style={styles.state}>
            <ErrorNotice
              error={candles.error}
              message="선물 차트를 불러오지 못했습니다. 잠시 후 다시 시도해주세요."
            />
            <ActionPressable
              testID="futures-chart-retry"
              accessibilityRole="button"
              accessibilityLabel="차트 다시 시도"
              style={styles.retry}
              onPress={() => void candles.refetch()}
            >
              <Text style={styles.retryText}>차트 다시 시도</Text>
            </ActionPressable>
          </View>
        ) : chartCandles.length > 0 ? (
          // Drawn over the box at the box's measured height: the chart never
          // sizes the box it is measured from (in the scrolling screen that
          // would keep a taller first draw, or an old height after a resize).
          <View style={styles.fill}>
            <CandlestickChart
              candles={chartCandles}
              height={
                chartHeight > 0
                  ? chartHeight
                  : detail
                    ? FUTURES_DETAIL_CHART_MIN_HEIGHT
                    : FUTURES_CHART_MIN_HEIGHT
              }
              currencyCode="USD"
              displayPriceDecimals={displayPriceDecimals}
              currentPrice={currentPrice}
              viewportResetKey={`${instrumentId}:${window.interval}`}
            />
          </View>
        ) : (
          <View style={styles.state}>
            <InlineEmptyState message="아직 수집된 선물 차트 데이터가 없습니다." />
          </View>
        )}
      </View>
      {detail ? selector : null}
    </View>
  );
}

// Plain objects (no module-level StyleSheet.create): screens are rendered by
// test harnesses whose react-native mocks may omit StyleSheet.
const styles = {
  box: { flex: 1, minHeight: 0, backgroundColor: semantic.surface },
  // The asset detail's card: the chart takes the height left under the price.
  detailBox: { flexGrow: 1, flexShrink: 0, backgroundColor: semantic.surface },
  // AssetChart's toolbar: the shared 봉 시간 selector at its left edge.
  toolbar: { backgroundColor: semantic.surface, paddingHorizontal: 12, paddingBottom: 8 },
  chart: { flex: 1, minHeight: FUTURES_CHART_MIN_HEIGHT },
  detailChart: { flex: 1, minHeight: FUTURES_DETAIL_CHART_MIN_HEIGHT },
  fill: { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 },
  state: { padding: 16, gap: 12 },
  notice: { paddingHorizontal: 12, paddingBottom: 8, fontSize: 12, color: semantic.warning },
  retry: {
    alignSelf: 'flex-start' as const,
    padding: 12,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 8,
    backgroundColor: semantic.raised,
  },
  retryText: { color: semantic.text },
};
