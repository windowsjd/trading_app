import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CandlestickChart from '../../components/charts/CandlestickChart';
import ChartLoading from '../../components/charts/ChartLoading';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  FUTURES_CHART_WINDOW,
  getFuturesInstrumentCandles,
} from '../../features/futures/api';

// The contract chart refreshes on the collection cadence (minute-scale);
// the live current price is shown separately by the screen.
const REFRESH_MS = 60_000;
/** Never below the old inline strip; with less room the screen scrolls. */
export const FUTURES_CHART_MIN_HEIGHT = 280;

type Props = {
  instrumentId: string;
  displayPriceDecimals: number | null;
  /** Fresh Futures Last only; null hides the current-price line. */
  currentPrice: string | null;
};

/**
 * 4h chart of ONE futures contract (Binance USDⓈ-M contract trade price),
 * drawn by the full-screen FuturesChart route like the spot AssetChart: the
 * chart takes the height its box is given (the rest of the screen, at least
 * FUTURES_CHART_MIN_HEIGHT), never a fixed strip. Mounted with `key={instrumentId}`, so a contract switch never
 * shows the previous contract's candles. Market data only: the query key
 * holds no trading account, and the component reads no position or
 * permission. The 4h/96-day window is the server's; nothing is filled in.
 */
export default function FuturesCandleChart({
  instrumentId,
  displayPriceDecimals,
  currentPrice,
}: Props) {
  const focused = useIsFocused();
  const [chartHeight, setChartHeight] = useState(0);
  const candles = useQuery({
    queryKey: QUERY_KEYS.futuresMarket.candles(instrumentId, FUTURES_CHART_WINDOW),
    queryFn: ({ signal }) => getFuturesInstrumentCandles(instrumentId, signal),
    enabled: focused,
    refetchInterval: focused ? REFRESH_MS : false,
    retry: false,
  });
  const data =
    candles.data?.instrument.id === instrumentId ? candles.data : undefined;
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
  const provisional = data?.candles.at(-1)?.provisional === true;

  return (
    <View testID="futures-candle-chart" style={styles.box}>
      <View style={styles.toolbar}>
        <Text style={styles.timeframe} accessibilityLabel="4시간봉 차트">4시간봉</Text>
        <Text style={styles.basis}>
          선물 계약 거래가격(Last) 기준 · 최근 96일
        </Text>
      </View>
      <View
        style={styles.chart}
        onLayout={(event) =>
          setChartHeight(Math.floor(event.nativeEvent.layout.height))
        }
      >
        {/* Only while this contract has no candles yet (first read or a
            retry); the minute refresh redraws behind the chart. */}
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
              height={chartHeight > 0 ? chartHeight : FUTURES_CHART_MIN_HEIGHT}
              currencyCode="USD"
              displayPriceDecimals={displayPriceDecimals}
              currentPrice={currentPrice}
              viewportResetKey={`${instrumentId}:${FUTURES_CHART_WINDOW.interval}`}
            />
          </View>
        ) : (
          <View style={styles.state}>
            <InlineEmptyState message="아직 수집된 선물 차트 데이터가 없습니다." />
          </View>
        )}
      </View>
      <Text style={styles.caption}>
        {provisional ? '마지막 봉은 진행 중인 잠정 봉입니다. ' : ''}
        Mark Price는 차트와 별개로 평가·청산에만 쓰입니다.
      </Text>
    </View>
  );
}

// Plain objects (no module-level StyleSheet.create): screens are rendered by
// test harnesses whose react-native mocks may omit StyleSheet.
const styles = {
  box: { flex: 1, minHeight: 0, backgroundColor: semantic.surface },
  // The spot chart's toolbar place (its 봉 시간 selector): this contract has 4h only.
  toolbar: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    alignItems: 'center' as const,
    columnGap: 8,
    rowGap: 4,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  timeframe: {
    borderRadius: 999,
    overflow: 'hidden' as const,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: semantic.selected,
    color: semantic.onAccent,
    fontWeight: '600' as const,
  },
  basis: { flexShrink: 1, color: semantic.secondary, fontSize: 13, lineHeight: 19 },
  chart: { flex: 1, minHeight: FUTURES_CHART_MIN_HEIGHT },
  fill: { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 },
  state: { padding: 16, gap: 12 },
  retry: {
    alignSelf: 'flex-start' as const,
    padding: 12,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 8,
    backgroundColor: semantic.raised,
  },
  retryText: { color: semantic.text },
  caption: {
    color: semantic.secondary,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
  },
};
