import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import Svg, { Path } from 'react-native-svg';
import { ScrollView, Text, View } from '../../theme/native';
import { SafeAreaView, useSafeAreaInsets } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import FullPageLoading from '../../components/states/FullPageLoading';
import { QUERY_KEYS } from '../../constants/queryKeys';
import type { FuturesDetailScreenProps } from '../../app/navigation/types';
import { getFuturesInstruments } from '../../features/futures/api';
import { freshFuturesReference, futuresServerNow } from '../../features/futures/policy';
import { resolveAccountBinding } from '../../features/tradingAccount/accountBinding';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import { formatAssetPrice } from '../../utils/format';
import FuturesCandleChart from './FuturesCandleChart';

/**
 * A futures contract's detail, between the market's 선물 list and the futures
 * order screen as AssetDetail sits before Order: the contract and its current
 * Futures Last, the contract's chart (its own Last candles at 4h, the one
 * interval it stores) with the full-screen view, and 판매하기 / 구매하기 at the
 * bottom. 구매하기 opens the order screen on a new 롱(Long) entry and 판매하기 on
 * a new 숏(Short) entry: never a reduce or close. With a position already held
 * the order screen keeps that position's terms (one-way) and says why the other
 * side waits. Prices are the contract's own Last only, never Mark or a Spot price.
 */
export default function FuturesDetailScreen({ route, navigation }: FuturesDetailScreenProps) {
  const { accountId, instrumentId } = route.params;
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { colors } = useAppearance();
  const { accounts, selectedAccountId, isLoading } = useTradingAccount();
  const binding = resolveAccountBinding({ boundAccountId: accountId, selectedAccountId, accounts, accountsLoading: isLoading });
  const bound = binding.state === 'bound';
  // The Last is judged on the read's server clock, re-read every second.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!focused) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [focused]);
  // The futures screen's own contract list (same key): its Last, polled while in front.
  const instruments = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.instruments(accountId),
    queryFn: ({ signal }) => getFuturesInstruments(accountId, signal),
    enabled: focused && bound,
    refetchInterval: focused && bound ? 2000 : false,
    retry: false,
  });
  if (binding.state === 'loading') return <FullPageLoading message="선물 계정을 확인하고 있습니다." />;
  if (!bound)
    return (
      <View style={[styles.card, styles.unbound]} testID="futures-detail-unbound">
        <Text style={styles.heading}>선택한 계정이 변경되었습니다.</Text>
        <Text style={styles.muted}>마켓에서 선물 상품을 다시 선택해주세요.</Text>
        <CTAButton label="마켓으로" onPress={() => navigation.navigate('Market')} />
      </View>
    );
  const data = instruments.data?.tradingAccountId === accountId ? instruments.data : undefined;
  const instrument = instruments.isError ? undefined : data?.instruments.find((item) => item.id === instrumentId);
  const missing = !!data && !instrument;
  const last = instrument?.referencePrice ?? null;
  const lastFresh = !!last && freshFuturesReference(instrument?.referencePriceEvidence, futuresServerNow(data, clock));
  const symbol = instrument?.underlying.symbol ?? '선물 상품';
  const decimals = instrument?.underlying.displayPriceDecimals;
  const open = (direction: 'long' | 'short') => navigation.navigate('Futures', { accountId, instrumentId, direction });
  const tradable = !!instrument;
  return (
    <SafeAreaView edges={['left', 'right']} style={styles.screen} testID="futures-detail-screen">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} nestedScrollEnabled>
        <View style={styles.header}>
          <View style={styles.headingBlock}>
            <View style={styles.titleRow}>
              <Text testID="futures-detail-symbol" style={styles.title}>{symbol}</Text>
              <Text style={styles.badge}>무기한</Text>
            </View>
            {instrument ? <Text style={styles.muted}>{instrument.underlying.name}</Text> : null}
            <Text testID="futures-detail-last" style={styles.price} selectable>
              Last {lastFresh && last ? formatAssetPrice(last, 'USD', decimals) : instruments.isPending ? '확인 중' : '시세 확인 불가'}
            </Text>
          </View>
          {instrument ? (
            <ActionPressable
              testID="futures-detail-open-chart"
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="전체화면 차트 열기"
              onPress={() => navigation.navigate('FuturesChart', {
                accountId, instrumentId, symbol: instrument.underlying.symbol, displayPriceDecimals: instrument.underlying.displayPriceDecimals,
              })}
            >
              <Svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
                <Path d="M5 3v18M2 8h6v7H2zM12 2v17M9 5h6v8H9zM19 6v16M16 11h6v7h-6z" fill="none"
                  stroke={colors.secondary} strokeWidth={1.5} />
              </Svg>
            </ActionPressable>
          ) : null}
        </View>
        {instruments.isError ? (
          <ErrorNotice error={instruments.error} style={styles.notice}
            message="상품 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." />
        ) : null}
        {missing ? <Text testID="futures-detail-missing" style={[styles.muted, styles.notice]}>현재 거래할 수 있는 선물 상품이 아닙니다.</Text> : null}
        <FuturesCandleChart key={instrumentId} instrumentId={instrumentId}
          displayPriceDecimals={decimals ?? 2} currentPrice={lastFresh ? last : null} />
      </ScrollView>
      {/* The tab bar is hidden here (MainTabs): the bar clears the system navigation area itself. */}
      <View style={{ ...styles.footer, paddingBottom: styles.footer.paddingBottom + insets.bottom }} testID="futures-detail-actions">
        <Text style={styles.footerHint}>구매하기는 롱(Long), 판매하기는 숏(Short) 신규 진입 주문으로 이어집니다.</Text>
        <View style={styles.actions}>
          <View style={styles.action}>
            <CTAButton testID="futures-detail-short" label="판매하기" state={tradable ? 'enabled' : 'disabled'}
              accessibilityHint="숏(Short) 신규 진입 주문을 엽니다." onPress={() => open('short')}
              style={{ ...styles.actionButton, backgroundColor: SELL_COLOR }} />
          </View>
          <View style={styles.action}>
            <CTAButton testID="futures-detail-long" label="구매하기" state={tradable ? 'enabled' : 'disabled'}
              accessibilityHint="롱(Long) 신규 진입 주문을 엽니다." onPress={() => open('long')}
              style={{ ...styles.actionButton, backgroundColor: BUY_COLOR }} />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

// Plain objects: screen harnesses load this with minimal react-native mocks.
const styles = {
  screen: { flex: 1, minHeight: 0, backgroundColor: semantic.screen },
  scroll: { flex: 1 },
  content: { flexGrow: 1 },
  header: { backgroundColor: semantic.surface, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, padding: 16 },
  headingBlock: { flex: 1, minWidth: 0, gap: 4 },
  titleRow: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, columnGap: 8, rowGap: 4 },
  title: { fontSize: 20, fontWeight: '700' as const, color: semantic.text, flexShrink: 1 },
  badge: { fontSize: 11, color: semantic.muted, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: semantic.raised, borderRadius: 5 },
  price: { fontSize: 15, color: semantic.secondary, fontVariant: ['tabular-nums' as const] },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
  notice: { marginHorizontal: 16, marginTop: 8 },
  muted: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  card: { margin: 16, padding: 16, gap: 10, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  unbound: { alignSelf: 'stretch' as const },
  heading: { fontSize: 17, fontWeight: '700' as const, color: semantic.text },
  footer: {
    flexShrink: 0,
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: semantic.border,
    backgroundColor: semantic.surface,
  },
  footerHint: { fontSize: 12, lineHeight: 17, color: semantic.secondary, textAlign: 'center' as const },
  actions: { flexDirection: 'row' as const, gap: 10 },
  action: { flex: 1, minWidth: 0 },
  actionButton: { minHeight: 50, paddingHorizontal: 8 },
};
