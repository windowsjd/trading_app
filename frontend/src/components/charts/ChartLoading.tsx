import { semantic } from '../../theme/tokens';
import React from 'react';
import { Text, View } from '../../theme/native';
import WhaleLoader from '../states/WhaleLoader';

/**
 * A candle chart's own box while its candles are being read: first load,
 * another 봉 시간 or asset, a retry after a failure. The whale is centered
 * where the chart will be drawn; the header, notices and controls around the
 * box stay. The caller shows it only while there are no candles for the
 * current request (never over cached or previous candles) and swaps it for
 * the chart, the error or the empty state as soon as the read settles.
 */
export default function ChartLoading() {
  return (
    <View testID="chart-loading" style={styles.container}>
      <WhaleLoader size={40} accessibilityLabel="차트를 불러오는 중" />
      <Text style={styles.text}>차트를 불러오는 중입니다.</Text>
    </View>
  );
}

// Plain objects (no module-level StyleSheet.create): screens that draw charts
// are rendered by test harnesses whose react-native mocks may omit StyleSheet.
const styles = {
  container: {
    flex: 1,
    minHeight: 160,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 12,
    padding: 16,
  },
  text: { fontSize: 14, color: semantic.secondary, textAlign: 'center' as const },
};
