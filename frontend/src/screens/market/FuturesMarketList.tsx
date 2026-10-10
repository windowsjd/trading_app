import { QUERY_KEYS } from '../../constants/queryKeys';
import React, { useRef, useState } from 'react';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Text, TextInput, View, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getFuturesInstruments } from '../../features/futures/api';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorState from '../../components/states/ErrorState';
import { formatDisplayDecimal } from '../../utils/format';

export default function FuturesMarketList({ onSelect }: { onSelect: (accountId: string, instrumentId: string) => void }) {
  const { selectedAccountId } = useTradingAccount();
  const focused = useIsFocused();
  const currentAccount = useRef(selectedAccountId);
  currentAccount.current = selectedAccountId;
  const session = getSessionGeneration();
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: QUERY_KEYS.tradingAccount.futures.instruments(selectedAccountId ?? ''), queryFn: ({ signal }) => getFuturesInstruments(selectedAccountId, signal), enabled: !!selectedAccountId && focused, refetchInterval: focused ? 5000 : false });
  if (!selectedAccountId) return <Text style={styles.text}>거래 계정을 선택하면 선물 상품을 볼 수 있습니다.</Text>;
  if (query.isError) return <ErrorState error={query.error} message="선물 상품을 불러오지 못했습니다." onRetry={() => void query.refetch()} />;
  const data = query.data?.tradingAccountId === selectedAccountId ? query.data : undefined;
  if (!data) return <Text style={styles.text}>선물 상품을 확인하고 있습니다.</Text>;
  const rows = data.instruments.filter(i => `${i.underlying.name} ${i.underlying.symbol}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <View testID="futures-market-list" style={styles.list}>
    <TextInput accessibilityLabel="선물 상품 검색" placeholder="이름 또는 심볼 검색" value={search} onChangeText={setSearch} style={styles.input} />
    <Text style={styles.hint}>현재가 · 선물 Last 거래 기준 / Mark · 평가·청산 기준</Text>
    {data.capabilities.tradingMode !== 'ENABLED' ? <Text style={styles.hint}>현재 신규 선물 거래가 제한되어 있습니다. 상품과 보유 현황은 확인할 수 있습니다.</Text> : null}
    {rows.map(i => <ActionPressable key={i.id} accessibilityRole="button" testID={`futures-market-${i.id}`} onPress={() => { if (focused && currentAccount.current === selectedAccountId && isCurrentSession(session)) onSelect(selectedAccountId, i.id); }} style={styles.row}>
      <Text style={styles.name}>{i.underlying.name} · {i.underlying.symbol}</Text>
      <Text style={styles.text}>현재가 {i.referencePrice ? `$${formatDisplayDecimal(i.referencePrice)}` : '확인 불가'}</Text>
      <Text style={styles.hint}>Mark {i.markPrice ? `$${formatDisplayDecimal(i.markPrice)}` : '확인 불가'}</Text>
    </ActionPressable>)}
    {!rows.length ? <Text style={styles.text}>현재 조회 가능한 선물 상품이 없습니다.</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ list: { gap: 12 }, row: { minWidth: 0, gap: 6, paddingVertical: 14, borderTopWidth: 1, borderColor: semantic.border }, name: { fontSize: 17, fontWeight: '700', color: semantic.text, flexShrink: 1 }, text: { fontSize: 15, color: semantic.text, flexShrink: 1 }, hint: { fontSize: 13, color: semantic.secondary, flexShrink: 1 }, input: { borderWidth: 1, borderColor: semantic.border, color: semantic.text, padding: 12, borderRadius: 10 } });
