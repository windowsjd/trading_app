import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { ScrollView, Text, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import { QUERY_KEYS } from '../../constants/queryKeys';
import type { FuturesChartScreenProps } from '../../app/navigation/types';
import { getFuturesInstruments } from '../../features/futures/api';
import { freshFuturesReference, futuresServerNow } from '../../features/futures/policy';
import { formatAssetPrice } from '../../utils/format';
import FuturesCandleChart from './FuturesCandleChart';

/**
 * The futures contract's chart on a whole screen, opened by the futures
 * screen's chart button as the spot order screen opens AssetChart: back
 * button, contract and its current Futures Last on top, then the 4h chart in
 * the rest of the screen (never below the old 280 px strip: with little room,
 * e.g. large text on a small phone, the screen scrolls instead, as the asset
 * detail chart does). The futures screen stays mounted underneath, so 뒤로
 * returns to its form as it was. The Last is the contract's own trade price
 * from the account's contract list (the futures screen's read, polled here
 * while this screen is in front); never Mark or a Spot price, and none when
 * it is not fresh.
 */
export default function FuturesChartScreen({ route, navigation }: FuturesChartScreenProps) {
  const { accountId, instrumentId, symbol, displayPriceDecimals } = route.params;
  const focused = useIsFocused();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const instruments = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.instruments(accountId),
    queryFn: ({ signal }) => getFuturesInstruments(accountId, signal),
    enabled: focused,
    refetchInterval: 2000,
    retry: false,
  });
  const instrument = instruments.isError
    ? undefined
    : instruments.data?.instruments.find((item) => item.id === instrumentId);
  const last = instrument?.referencePrice ?? null;
  const lastFresh = !!last && freshFuturesReference(
    instrument?.referencePriceEvidence,
    futuresServerNow(instruments.data, clock),
  );
  return (
    <SafeAreaView style={styles.screen} testID="futures-chart-screen">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} nestedScrollEnabled>
        <View style={styles.header}>
          <ActionPressable testID="futures-chart-back" accessibilityRole="button"
            accessibilityLabel="차트 뒤로가기" style={styles.back} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>←</Text>
          </ActionPressable>
          <View style={styles.heading}>
            {/* The futures screen's own pair line: symbol and its 무기한 badge. */}
            <View style={styles.titleRow}>
              <Text testID="futures-chart-symbol" style={styles.title}>{symbol}</Text>
              <Text style={styles.badge}>무기한</Text>
            </View>
            <Text testID="futures-chart-last" style={styles.price} selectable>
              Last {lastFresh && last ? formatAssetPrice(last, 'USD', displayPriceDecimals) : '시세 확인 불가'}
            </Text>
          </View>
        </View>
        <FuturesCandleChart
          key={instrumentId}
          instrumentId={instrumentId}
          displayPriceDecimals={displayPriceDecimals}
          currentPrice={lastFresh ? last : null}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

// Plain objects (no module-level StyleSheet.create): screens are rendered by
// test harnesses whose react-native mocks may omit StyleSheet. Same header as
// AssetChart's full-screen variant.
const styles = {
  screen: { flex: 1, minHeight: 0, backgroundColor: semantic.screen },
  scroll: { flex: 1 },
  // Exactly the screen when everything fits, so the chart takes the rest.
  content: { flexGrow: 1 },
  header: {
    backgroundColor: semantic.surface,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  back: { minWidth: 44, minHeight: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
  backText: { fontSize: 26, color: semantic.text },
  heading: { flex: 1, minWidth: 0, gap: 4 },
  titleRow: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, columnGap: 8, rowGap: 4 },
  title: { fontSize: 18, fontWeight: '700' as const, color: semantic.text, flexShrink: 1 },
  badge: { fontSize: 11, color: semantic.muted, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: semantic.raised, borderRadius: 5 },
  price: { fontSize: 15, color: semantic.secondary, fontVariant: ['tabular-nums' as const] },
};
