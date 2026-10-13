import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CandlestickChart from '../../components/charts/CandlestickChart';
import ErrorNotice from '../../components/states/ErrorNotice';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  FUTURES_CHART_WINDOW,
  getFuturesInstrumentCandles,
} from '../../features/futures/api';

// The contract chart refreshes on the collection cadence (minute-scale);
// the live current price is shown separately by the screen.
const REFRESH_MS = 60_000;
const CHART_HEIGHT = 280;

type Props = {
  instrumentId: string;
  displayPriceDecimals: number | null;
  /** Fresh Futures Last only; null hides the current-price line. */
  currentPrice: string | null;
};

/**
 * 4h chart of ONE futures contract (Binance USDⓈ-M contract trade price).
 * Mounted with `key={instrumentId}` by the screen so a contract switch never
 * shows the previous contract's candles. Market data only: the query key holds
 * no trading account, and the component reads no position or permission.
 */
export default function FuturesCandleChart({
  instrumentId,
  displayPriceDecimals,
  currentPrice,
}: Props) {
  const focused = useIsFocused();
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
      <Text style={styles.title}>4시간봉 차트</Text>
      <Text style={styles.basis}>
        선물 계약 거래가격(Last) 기준 · 최근 96일
      </Text>
      {candles.isLoading ? (
        <SectionSkeleton lines={6} />
      ) : candles.isError && !data ? (
        <ErrorNotice
          error={candles.error}
          message="선물 차트를 불러오지 못했습니다. 잠시 후 다시 시도해주세요."
        />
      ) : chartCandles.length > 0 ? (
        <CandlestickChart
          candles={chartCandles}
          height={CHART_HEIGHT}
          currencyCode="USD"
          displayPriceDecimals={displayPriceDecimals}
          currentPrice={currentPrice}
          viewportResetKey={`${instrumentId}:${FUTURES_CHART_WINDOW.interval}`}
        />
      ) : (
        <InlineEmptyState message="아직 수집된 선물 차트 데이터가 없습니다." />
      )}
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
  box: { gap: 6, marginTop: 4 },
  title: { color: semantic.text, fontSize: 16, fontWeight: '700' as const },
  basis: { color: semantic.secondary, fontSize: 13, lineHeight: 19 },
  caption: { color: semantic.secondary, fontSize: 12, lineHeight: 18 },
};
