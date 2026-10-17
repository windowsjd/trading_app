import { QUERY_KEYS } from '../../constants/queryKeys';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Text, TextInput, View, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getFuturesInstruments } from '../../features/futures/api';
import { futuresMarketRow, sortFuturesMarket } from '../../features/futures/marketList';
import MarketSortControl from '../../features/market/MarketSortControl';
import MarketAssetRow from '../../features/market/MarketAssetRow';
import type { MarketSort } from '../../features/market/marketSort';
import ErrorState from '../../components/states/ErrorState';

/**
 * Market › 암호화폐 › 선물, in the Spot list's structure: the same sort control
 * and rows. Price = Futures Last; change and turnover = the contract's own 24h
 * statistics. Like Spot's frozen snapshot, the ranking changes only with the
 * sort, the contract set or an explicit refresh, while values update in place.
 */
export default function FuturesMarketList({ onSelect, sort, onSortChange, refreshVersion = 0 }: {
  onSelect: (accountId: string, instrumentId: string) => void;
  sort: MarketSort;
  onSortChange: (sort: MarketSort) => void;
  /** Pull-to-refresh count from the market screen: refetch, then re-rank. */
  refreshVersion?: number;
}) {
  const { selectedAccountId } = useTradingAccount();
  const focused = useIsFocused();
  const currentAccount = useRef(selectedAccountId);
  currentAccount.current = selectedAccountId;
  const session = getSessionGeneration();
  const [search, setSearch] = useState('');
  const [ranking, setRanking] = useState(0);
  const query = useQuery({ queryKey: QUERY_KEYS.tradingAccount.futures.instruments(selectedAccountId ?? ''), queryFn: ({ signal }) => getFuturesInstruments(selectedAccountId, signal), enabled: !!selectedAccountId && focused, refetchInterval: focused ? 5000 : false });
  const { refetch } = query;
  useEffect(() => {
    if (!refreshVersion) return undefined;
    let live = true;
    void refetch().then(() => { if (live) setRanking((value) => value + 1); });
    return () => { live = false; };
  }, [refreshVersion, refetch]);
  const data = query.data?.tradingAccountId === selectedAccountId ? query.data : undefined;
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
    if (focused && selectedAccountId && currentAccount.current === selectedAccountId && isCurrentSession(session))
      onSelect(selectedAccountId, instrumentId);
  }, [focused, selectedAccountId, session, onSelect]);
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
  if (!selectedAccountId) return <Text style={styles.text}>거래 계정을 선택하면 선물 상품을 볼 수 있습니다.</Text>;
  if (query.isError) return <ErrorState error={query.error} message="선물 상품을 불러오지 못했습니다." onRetry={() => void query.refetch()} />;
  if (!data) return <Text style={styles.text}>선물 상품을 확인하고 있습니다.</Text>;
  return <View testID="futures-market-list" style={styles.list}>
    <TextInput accessibilityLabel="선물 상품 검색" placeholder="이름 또는 심볼 검색" value={search} onChangeText={setSearch} style={styles.input} />
    <View style={styles.toolbar}>
      <Text testID="futures-list-summary" style={styles.summary}>USDⓈ-M 무기한 · 24시간 기준</Text>
      <MarketSortControl value={sort} onChange={onSortChange} />
    </View>
    {data.capabilities.tradingMode !== 'ENABLED' ? <Text style={styles.hint}>현재 신규 선물 거래가 제한되어 있습니다. 상품과 보유 현황은 확인할 수 있습니다.</Text> : null}
    <View>
      {rows.map(({ id, item }) => (
        <MarketAssetRow key={id} item={item} onPress={press} testID={`futures-market-${id}`} changeTestID={`futures-change-${id}`} />
      ))}
    </View>
    {!rows.length ? <Text style={styles.text}>현재 조회 가능한 선물 상품이 없습니다.</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  list: { gap: 12 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 8, rowGap: 0 },
  summary: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 12, lineHeight: 18, color: semantic.secondary },
  text: { fontSize: 15, color: semantic.text, flexShrink: 1 },
  hint: { fontSize: 13, color: semantic.secondary, flexShrink: 1 },
  input: { borderWidth: 1, borderColor: semantic.border, color: semantic.text, padding: 12, borderRadius: 10 },
});
