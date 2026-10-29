import { QUERY_KEYS } from '../../constants/queryKeys';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Text, TextInput, View, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getFuturesInstruments, getFuturesMarketInstruments, isAccountFuturesInstruments, type FuturesInstruments, type FuturesMarketInstruments } from '../../features/futures/api';
import { guestRefetchInterval, isGuestBrowsing, isGuestSignInRequired, retryGuestRead } from '../../features/auth/guestBrowsing';
import { futuresMarketRow, sortFuturesMarket } from '../../features/futures/marketList';
import MarketSortControl from '../../features/market/MarketSortControl';
import MarketAssetRow from '../../features/market/MarketAssetRow';
import type { MarketSort } from '../../features/market/marketSort';
import ErrorState from '../../components/states/ErrorState';
import { GuestSignInPanel } from '../../components/guest/GuestSignIn';

/**
 * Market › 암호화폐 › 선물, in the Spot list's structure: the market screen draws
 * the search and sort controls inside its header card and the rows below it,
 * at the Spot rows' own width and spacing (the same MarketAssetRow, no inner
 * padding). Price = Futures Last; change and turnover = the contract's own 24h
 * statistics. Like Spot's frozen snapshot, the ranking changes only with the
 * sort, the contract set or an explicit refresh, while values update in place.
 * A hook, so the screen's segments stay mounted when 현물/선물 switches.
 *
 * Guest browsing (2026-10-30) reads the same contracts as market data (no
 * account), polled the same way; a 401 there is "sign in to see 선물".
 */
export function useFuturesMarket({ active, onSelect, sort, refreshVersion = 0 }: {
  /** 선물 is the shown list: it reads and polls only then. */
  active: boolean;
  /** A guest has no account: null. */
  onSelect: (accountId: string | null, instrumentId: string) => void;
  sort: MarketSort;
  /** Pull-to-refresh count from the market screen: refetch, then re-rank. */
  refreshVersion?: number;
}) {
  const guest = isGuestBrowsing();
  const { selectedAccountId } = useTradingAccount();
  const focused = useIsFocused();
  const currentAccount = useRef(selectedAccountId);
  currentAccount.current = selectedAccountId;
  const session = getSessionGeneration();
  const [search, setSearch] = useState('');
  const [ranking, setRanking] = useState(0);
  const live = active && focused;
  const query = useQuery<FuturesInstruments | FuturesMarketInstruments>({
    queryKey: guest ? QUERY_KEYS.futuresMarket.instruments() : QUERY_KEYS.tradingAccount.futures.instruments(selectedAccountId ?? ''),
    queryFn: ({ signal }) => (guest ? getFuturesMarketInstruments(signal) : getFuturesInstruments(selectedAccountId, signal)),
    enabled: (guest || !!selectedAccountId) && live, refetchInterval: live ? 5000 : false,
    // A guest: the same poll, which stops after a sign-in 401.
    ...(guest ? { retry: retryGuestRead, refetchInterval: guestRefetchInterval(live, 5000) } : {}),
  });
  const { refetch } = query;
  useEffect(() => {
    if (!refreshVersion) return undefined;
    let current = true;
    void refetch().then(() => { if (current) setRanking((value) => value + 1); });
    return () => { current = false; };
  }, [refreshVersion, refetch]);
  // Leaving 선물 clears its search, as the list's own unmount used to.
  useEffect(() => { if (!active) setSearch(''); }, [active]);
  const data = guest || (query.data && isAccountFuturesInstruments(query.data) && query.data.tradingAccountId === selectedAccountId)
    ? query.data : undefined;
  // Re-rank only when the sort, the contract set or an explicit refresh
  // changes; a poll updates values in place (React's "previous render" pattern).
  const rankKey = data ? `${sort}|${data.instruments.map((instrument) => instrument.id).join(',')}|${ranking}` : '';
  const [ranked, setRanked] = useState({ key: '', order: [] as string[] });
  let order = ranked.order;
  if (ranked.key !== rankKey) {
    order = data ? sortFuturesMarket(data.instruments, sort).map((instrument) => instrument.id) : [];
    setRanked({ key: rankKey, order });
  }
  const press = useCallback((instrumentId: string) => {
    if (guest) {
      if (active && focused) onSelect(null, instrumentId);
      return;
    }
    if (active && focused && selectedAccountId && currentAccount.current === selectedAccountId && isCurrentSession(session))
      onSelect(selectedAccountId, instrumentId);
  }, [guest, active, focused, selectedAccountId, session, onSelect]);
  const rows = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.instruments.map((instrument) => [instrument.id, instrument]));
    const needle = search.trim().toLowerCase();
    return order.flatMap((id) => {
      const instrument = byId.get(id);
      return instrument && `${instrument.underlying.name} ${instrument.underlying.symbol}`.toLowerCase().includes(needle)
        ? [{ id, item: futuresMarketRow(instrument) }]
        : [];
    });
  }, [data, order, search]);
  const state = guest && query.isError && isGuestSignInRequired(query.error) ? 'signIn' as const
    : !guest && !selectedAccountId ? 'noAccount' as const : query.isError ? 'error' as const : !data ? 'loading' as const : 'ready' as const;
  // A guest's market data carries no capabilities: no trading notice.
  const tradingMode = data && isAccountFuturesInstruments(data) ? data.capabilities.tradingMode : null;
  return { state, error: query.error, retry: () => void query.refetch(), tradingMode,
    search, setSearch, rows, press };
}

export type FuturesMarket = ReturnType<typeof useFuturesMarket>;

/** Search, sort and the trading notice: inside the market screen's header card. */
export function FuturesMarketControls({ market, sort, onSortChange }: {
  market: FuturesMarket;
  sort: MarketSort;
  onSortChange: (sort: MarketSort) => void;
}) {
  if (market.state !== 'ready') return null;
  return <View testID="futures-list-controls" style={styles.controls}>
    <TextInput accessibilityLabel="선물 상품 검색" placeholder="이름 또는 심볼 검색" value={market.search} onChangeText={market.setSearch} style={styles.input} />
    <View style={styles.toolbar}>
      <Text testID="futures-list-summary" style={styles.summary}>USDⓈ-M 무기한 · 24시간 기준</Text>
      <MarketSortControl value={sort} onChange={onSortChange} />
    </View>
    {market.tradingMode && market.tradingMode !== 'ENABLED' ? <Text style={styles.hint}>현재 신규 선물 거래가 제한되어 있습니다. 상품과 보유 현황은 확인할 수 있습니다.</Text> : null}
  </View>;
}

/** The rows (or why there are none), below the header card like Spot's rows. */
export function FuturesMarketRows({ market }: { market: FuturesMarket }) {
  if (market.state === 'noAccount') return <Text style={styles.text}>거래 계정을 선택하면 선물 상품을 볼 수 있습니다.</Text>;
  // Guest browsing, futures market data not served to signed-out visitors.
  if (market.state === 'signIn') return <GuestSignInPanel testID="market-futures-sign-in" title="로그인하면 선물 시세를 확인할 수 있습니다." />;
  if (market.state === 'error') return <ErrorState error={market.error} message="선물 상품을 불러오지 못했습니다." onRetry={market.retry} />;
  if (market.state === 'loading') return <Text style={styles.text}>선물 상품을 확인하고 있습니다.</Text>;
  return <View testID="futures-market-list">
    {market.rows.map(({ id, item }) => (
      <MarketAssetRow key={id} item={item} onPress={market.press} testID={`futures-market-${id}`} changeTestID={`futures-change-${id}`} />
    ))}
    {!market.rows.length ? <Text style={styles.text}>현재 조회 가능한 선물 상품이 없습니다.</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  // The header card's own gap between its controls.
  controls: { gap: 12 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 8, rowGap: 0 },
  summary: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 12, lineHeight: 18, color: semantic.secondary },
  text: { fontSize: 15, color: semantic.text, flexShrink: 1 },
  hint: { fontSize: 13, color: semantic.secondary, flexShrink: 1 },
  input: { borderWidth: 1, borderColor: semantic.border, color: semantic.text, padding: 12, borderRadius: 10 },
});
