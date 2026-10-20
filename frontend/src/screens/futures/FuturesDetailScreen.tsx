import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { ScrollView, Text, View } from '../../theme/native';
import { SafeAreaView, useSafeAreaInsets } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import DisclosureTriangle from '../../components/common/DisclosureTriangle';
import ErrorNotice from '../../components/states/ErrorNotice';
import FullPageLoading from '../../components/states/FullPageLoading';
import { QUERY_KEYS } from '../../constants/queryKeys';
import type { FuturesDetailScreenProps } from '../../app/navigation/types';
import {
  DEFAULT_ASSET_CHART_TIMEFRAME,
  type AssetChartTimeframe,
} from '../../features/asset/chartTimeframes';
import {
  FUTURES_CHART_REFRESH_MS,
  getFuturesInstrumentCandles,
  getFuturesInstruments,
  getFuturesPositions,
} from '../../features/futures/api';
import {
  FUTURES_PREVIOUS_DAY_RETRY_MS,
  FUTURES_PREVIOUS_DAY_WINDOW,
  futuresKrwPrice,
  futuresPreviousDayChange,
  futuresPreviousDayChangeLabel,
  futuresPreviousDayClose,
  futuresPreviousUtcDayStart,
} from '../../features/futures/detailDisplay';
import { freshFuturesReference, futuresServerNow } from '../../features/futures/policy';
import { useLearningAccess } from '../../features/quest/useLearningAccess';
import { resolveAccountBinding } from '../../features/tradingAccount/accountBinding';
import { usdKrwRefetchDelay } from '../../features/tradingAccount/homePortfolio';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import { getCurrentFxRate } from '../../features/wallet/api';
import { formatAssetPrice } from '../../utils/format';
import FuturesCandleChart from './FuturesCandleChart';
import FuturesInstrumentSheet from './FuturesInstrumentSheet';

export default function FuturesDetailScreen(props: FuturesDetailScreenProps) {
  // Another contract (the picker) or account recreates the whole view: no
  // price, 봉 시간, currency or chart of the previous contract stays.
  const { accountId, instrumentId } = props.route.params;
  return <FuturesDetailContent key={`${accountId}:${instrumentId}`} {...props} />;
}

/**
 * A futures contract's detail in the asset detail's layout (종목 상세): the
 * contract's name with the contract picker, its USD badge and contract line,
 * the current Futures Last large with its won conversion and the $ | 원
 * switch, its 전일대비 (against its own settled 1d close of the previous UTC
 * day, never the rolling 24h ticker), its chart with the 봉 시간
 * selector at the lower left, and 매도하기 / 매수하기 at the bottom. 매수하기
 * opens the order screen on a new 롱(Long) entry and 매도하기 on a new 숏(Short)
 * entry — never a reduce or close; with a position held, the order screen keeps
 * that position's terms (one-way) and says why the other side waits. The full-
 * screen chart is opened from the order screen's chart button, as for stocks.
 *
 * Prices are the contract's own Last (never Mark or a Spot price); the won
 * figure is display only (the contract trades, margins and settles in USD) and
 * appears only with a fresh Last and a current USD/KRW rate.
 */
function FuturesDetailContent({ route, navigation }: FuturesDetailScreenProps) {
  const { accountId, instrumentId } = route.params;
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { accounts, selectedAccountId, selectedAccount, isLoading } = useTradingAccount();
  const binding = resolveAccountBinding({ boundAccountId: accountId, selectedAccountId, accounts, accountsLoading: isLoading });
  const bound = binding.state === 'bound';
  const [displayCurrency, setDisplayCurrency] = useState<'USD' | 'KRW'>('USD');
  const [timeframe, setTimeframe] = useState<AssetChartTimeframe>(DEFAULT_ASSET_CHART_TIMEFRAME);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The Last, 전일대비's UTC day and the won rate are judged on the read's
  // server clock — restarted on return, so nothing shows as fresh on an old clock.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!focused) return undefined;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [focused]);
  // The picker never stays over another screen.
  useEffect(() => {
    if (!focused) setPickerOpen(false);
  }, [focused]);
  // The futures screen's own contract list (same key): its Last, polled while in front.
  const instruments = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.instruments(accountId),
    queryFn: ({ signal }) => getFuturesInstruments(accountId, signal),
    enabled: focused && bound,
    refetchInterval: focused && bound ? 2000 : false,
    retry: false,
  });
  const data = instruments.data?.tradingAccountId === accountId ? instruments.data : undefined;
  // A failed poll keeps the last list (its Last ages out by its own evidence).
  const catalog = data?.instruments ?? [];
  const instrument = catalog.find((item) => item.id === instrumentId);
  const serverNow = futuresServerNow(data, clock);
  // 전일대비's basis: this contract's settled 1d close of the previous UTC day
  // (market data, the 1d chart's route). The day is in the key, so the basis
  // never outlives its day; without it the read is retried sooner.
  const daily = useQuery({
    queryKey: QUERY_KEYS.futuresMarket.previousDayCandles(instrumentId, futuresPreviousUtcDayStart(serverNow)),
    queryFn: ({ signal }) => getFuturesInstrumentCandles(instrumentId, FUTURES_PREVIOUS_DAY_WINDOW, signal),
    enabled: focused && bound && !!instrument,
    refetchInterval: (query) => (focused && bound
      ? futuresPreviousDayClose(query.state.data, instrument, serverNow)
        ? FUTURES_CHART_REFRESH_MS['1d'] : FUTURES_PREVIOUS_DAY_RETRY_MS
      : false),
    retry: false,
  });
  // The wallet's USD/KRW read (same key as the wallet and holdings), re-read
  // just after its display validity ends, as the holdings do.
  const fx = useQuery({
    queryKey: QUERY_KEYS.wallet.fxRate({ baseCurrency: 'USD', quoteCurrency: 'KRW', refresh: false }),
    queryFn: () => getCurrentFxRate('USD', 'KRW', false),
    enabled: focused && bound,
    refetchInterval: (query) => (focused && bound ? usdKrwRefetchDelay(query.state.data?.validUntil, Date.now()) : false),
    retry: false,
  });
  // A beginner's new entry is gated as on the order screen. With a position on
  // this contract (or positions unknown) the order screen shows that
  // position's terms and decides, so the detail never blocks the way there.
  const learning = useLearningAccess(accountId);
  // The same account test useLearningAccess applies.
  const beginner = selectedAccount?.id === accountId && selectedAccount.mode === 'beginner';
  const positions = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.positions(accountId),
    queryFn: ({ signal }) => getFuturesPositions(accountId, signal),
    enabled: focused && bound && beginner,
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
  const missing = !!data && !instrument;
  const last = instrument?.referencePrice ?? null;
  const lastFresh = !!last && freshFuturesReference(instrument?.referencePriceEvidence, serverNow);
  const decimals = instrument?.underlying.displayPriceDecimals;
  const usdPrice = lastFresh && last
    ? formatAssetPrice(last, 'USD', decimals)
    : instruments.isPending ? '시세 확인 중' : '시세 확인 불가';
  // A failed re-read drops the won figure rather than keep the last rate.
  const krwPrice = futuresKrwPrice({ last, lastFresh, fxRate: fx.isError ? null : fx.data, now: serverNow });
  const krwAvailable = krwPrice !== null;
  const useKrw = krwAvailable && displayCurrency === 'KRW';
  // In USD whatever the display currency: the won rate never moves it.
  const change = futuresPreviousDayChange({
    last, lastFresh, previousClose: futuresPreviousDayClose(daily.data, instrument, serverNow),
  });
  const name = instrument?.underlying.name ?? '선물 상품';
  const open = (direction: 'long' | 'short') => navigation.navigate('Futures', { accountId, instrumentId, direction });
  const tradable = !!instrument;
  const heldPositions = positions.data?.tradingAccountId === accountId ? positions.data.positions : undefined;
  const heldHere = heldPositions?.some((position) => position.instrumentId === instrumentId && Number(position.quantity) > 0);
  const entryGate = (direction: 'long' | 'short') =>
    beginner && heldHere === false ? learning.gate(direction === 'short' ? 'futuresShortOpen' : 'futuresLongOpen') : null;
  const shortGate = entryGate('short');
  const longGate = entryGate('long');
  return (
    // The tab bar is hidden on this screen (MainTabs), so the order bar is the
    // screen's bottom edge: it pads itself by the bottom inset (AssetDetail).
    <SafeAreaView edges={['left', 'right']} style={styles.screen} testID="futures-detail-screen">
      <View style={styles.body}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} nestedScrollEnabled>
          <View style={styles.detailHeader}>
            <View style={styles.nameRow}>
              <ActionPressable testID="futures-name-selector" style={styles.nameSelector}
                accessibilityRole="button" accessibilityLabel={`종목 변경, 현재 ${name}`}
                disabled={catalog.length === 0} onPress={() => setPickerOpen(true)}>
                <Text testID="futures-detail-name" style={styles.name}>{name}</Text>
                <DisclosureTriangle direction="down" />
              </ActionPressable>
              {instrument ? (
                <Text testID="futures-settlement-currency" style={styles.settlementBadge}>
                  {instrument.settlementCurrency}
                </Text>
              ) : null}
            </View>
            {instrument ? (
              // The contract's identity, as the asset detail's second line.
              <Text testID="futures-detail-contract" style={styles.contract}>
                {instrument.underlying.symbol} · USDⓈ-M 무기한
              </Text>
            ) : null}
            <View style={styles.priceRow}>
              <View style={styles.priceStack}>
                <Text testID="futures-detail-primary-price" style={styles.price} selectable>
                  {useKrw ? krwPrice : usdPrice}
                </Text>
                <Text testID="futures-detail-secondary-price" style={styles.secondaryPrice} selectable>
                  {useKrw ? usdPrice : (krwPrice ?? '원 환산 불가')}
                </Text>
              </View>
              <View style={styles.currencyToggle} accessibilityRole="radiogroup">
                <ActionPressable testID="futures-currency-usd" accessibilityRole="radio"
                  accessibilityState={{ selected: !useKrw }}
                  style={[styles.currencyOption, !useKrw && styles.currencySelected]}
                  onPress={() => setDisplayCurrency('USD')}>
                  <Text style={[styles.currencyText, !useKrw && styles.currencySelectedText]}>$</Text>
                </ActionPressable>
                <ActionPressable testID="futures-currency-krw" accessibilityRole="radio"
                  accessibilityState={{ selected: useKrw, disabled: !krwAvailable }}
                  disabled={!krwAvailable}
                  style={[styles.currencyOption, useKrw && styles.currencySelected]}
                  onPress={() => setDisplayCurrency('KRW')}>
                  <Text style={[styles.currencyText, useKrw && styles.currencySelectedText]}>원</Text>
                </ActionPressable>
              </View>
            </View>
            <Text testID="futures-day-change" style={[styles.change,
              change?.gt(0) ? styles.up : change?.lt(0) ? styles.down : null]}>
              {futuresPreviousDayChangeLabel(change)}
            </Text>
          </View>
          {instruments.isError ? (
            <ErrorNotice error={instruments.error} style={styles.notice}
              message="상품 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." />
          ) : null}
          {missing ? <Text testID="futures-detail-missing" style={[styles.muted, styles.notice]}>현재 거래할 수 있는 선물 상품이 아닙니다.</Text> : null}
          <FuturesCandleChart key={instrumentId} instrumentId={instrumentId} variant="detail"
            displayPriceDecimals={decimals ?? 2} currentPrice={lastFresh ? last : null}
            timeframe={timeframe} onTimeframeChange={setTimeframe} />
        </ScrollView>
        <View style={{ ...styles.footer, paddingBottom: styles.footer.paddingBottom + insets.bottom }} testID="futures-detail-actions">
          <View style={styles.action}>
            <CTAButton testID="futures-detail-short" label="매도하기" state={tradable ? 'enabled' : 'disabled'}
              accessibilityHint="숏(Short) 신규 진입 주문을 엽니다."
              learningHint={shortGate?.locked ? shortGate.message : null}
              onPress={() => (shortGate ? shortGate.guard(() => open('short')) : open('short'))}
              style={{ ...styles.actionButton, backgroundColor: SELL_COLOR }} />
          </View>
          <View style={styles.action}>
            <CTAButton testID="futures-detail-long" label="매수하기" state={tradable ? 'enabled' : 'disabled'}
              accessibilityHint="롱(Long) 신규 진입 주문을 엽니다."
              learningHint={longGate?.locked ? longGate.message : null}
              onPress={() => (longGate ? longGate.guard(() => open('long')) : open('long'))}
              style={{ ...styles.actionButton, backgroundColor: BUY_COLOR }} />
          </View>
        </View>
      </View>
      {/* The verified contract list only (the order screen's own picker). */}
      <FuturesInstrumentSheet visible={pickerOpen && focused} instruments={catalog} selectedId={instrumentId}
        onClose={() => setPickerOpen(false)}
        onSelect={(next) => {
          setPickerOpen(false);
          if (next !== instrumentId) navigation.setParams({ instrumentId: next });
        }} />
    </SafeAreaView>
  );
}

// Plain objects: screen harnesses load this with minimal react-native mocks.
// The header block, price row, toggle and order bar are AssetDetail's own.
const styles = {
  screen: { flex: 1, minHeight: 0, backgroundColor: semantic.screen },
  body: { flex: 1, minHeight: 0 },
  scroll: { flex: 1, minHeight: 0, backgroundColor: semantic.screen },
  content: { margin: 8, borderRadius: 14, backgroundColor: semantic.surface, flexGrow: 1 },
  detailHeader: { backgroundColor: semantic.surface, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 6 },
  nameRow: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, columnGap: 8, rowGap: 4 },
  nameSelector: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, minHeight: 44, minWidth: 0, maxWidth: '100%' as const, flexShrink: 1 },
  name: { minWidth: 0, fontSize: 28, fontWeight: '800' as const, color: semantic.text, flexShrink: 1 },
  settlementBadge: { fontSize: 11, fontWeight: '700' as const, color: semantic.secondary, backgroundColor: semantic.raised, overflow: 'hidden' as const, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 },
  contract: { minWidth: 0, fontSize: 13, lineHeight: 19, color: semantic.secondary },
  priceRow: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, gap: 10, paddingTop: 8 },
  priceStack: { flex: 1, minWidth: 0, gap: 2 },
  price: { fontSize: 34, fontWeight: '700' as const, color: semantic.text, fontVariant: ['tabular-nums' as const], flexShrink: 1 },
  secondaryPrice: { fontSize: 14, color: semantic.muted, flexShrink: 1 },
  currencyToggle: { flexDirection: 'row' as const, flexShrink: 0, borderRadius: 10, backgroundColor: semantic.raised, padding: 3, gap: 2 },
  currencyOption: { minWidth: 44, minHeight: 44, borderRadius: 8, alignItems: 'center' as const, justifyContent: 'center' as const },
  currencySelected: { backgroundColor: semantic.surface },
  currencyText: { fontSize: 15, fontWeight: '700' as const, color: semantic.muted },
  currencySelectedText: { color: semantic.text },
  change: { paddingTop: 6, fontSize: 13, color: semantic.muted, flexShrink: 1 },
  up: { color: financial.rise },
  down: { color: financial.fall },
  notice: { marginHorizontal: 16, marginBottom: 8 },
  muted: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  card: { margin: 16, padding: 16, gap: 10, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  unbound: { alignSelf: 'stretch' as const },
  heading: { fontSize: 17, fontWeight: '700' as const, color: semantic.text },
  footer: {
    flexShrink: 0,
    flexDirection: 'row' as const,
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: semantic.border,
    backgroundColor: semantic.surface,
  },
  action: { flex: 1, minWidth: 0 },
  actionButton: { minHeight: 50, paddingHorizontal: 8 },
};
