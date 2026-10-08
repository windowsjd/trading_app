import { QUERY_KEYS } from '../../constants/queryKeys';
import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import { getFuturesLimitOrders, cancelFuturesLimitOrder } from '../../features/futures/api';
import { getPendingProtections, cancelProtection } from '../../features/conditional/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatDisplayDecimal } from '../../utils/format';
import { invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation';

export default function PendingFuturesAndProtections({ accountId, focused, protections = false, seasonUi }: { accountId: string; focused: boolean; protections?: boolean; seasonUi: boolean }) {
  const { selectedAccountId } = useTradingAccount();
  const client = useQueryClient();
  const query = useQuery({ queryKey: protections ? QUERY_KEYS.tradingAccount.protections.pending(accountId) : QUERY_KEYS.tradingAccount.futures.pending(accountId), queryFn: async ({ signal }) => protections ? getPendingProtections(accountId, signal) : getFuturesLimitOrders(accountId, signal), enabled: focused && selectedAccountId === accountId, refetchInterval: focused ? 4000 : false });
  const [failure, setFailure] = useState<unknown>(null), [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true), locked = useRef(false), selected = useRef(selectedAccountId);
  selected.current = selectedAccountId;
  const session = getSessionGeneration();
  const cancelKeys = useRef(new Map<string, string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && selected.current === accountId && isCurrentSession(session);
  const data = !query.isError && query.data?.tradingAccountId === accountId ? query.data : undefined;
  const permission = useRef(false);
  permission.current = focused && !!data && ('orders' in data || data.capabilities.canCancel);
  const ids = data ? 'orders' in data ? data.orders.map(o => o.id).join(',') : data.groups.map(g => g.id).join(',') : undefined;
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (ids !== undefined && previous.current !== undefined && ids !== previous.current) void invalidateAfterOrderCreate(client, accountId, { seasonUi });
    if (ids !== undefined) previous.current = ids;
  }, [ids, accountId, client, seasonUi]);
  const cancel = async (id: string) => {
    if (locked.current || !permission.current || !current()) return;
    locked.current = true; setBusy(id); setFailure(null);
    try {
      if (protections) {
        const key = cancelKeys.current.get(id) ?? createIdempotencyKey('protection-cancel');
        cancelKeys.current.set(id, key);
        await cancelProtection(accountId, id, key);
      } else await cancelFuturesLimitOrder(accountId, id);
      if (!current()) return;
      await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) }), client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.protections.all(accountId) }), invalidateAfterOrderCreate(client, accountId, { seasonUi })]);
    } catch (error) { if (current()) setFailure(error); }
    finally { locked.current = false; if (current()) setBusy(null); }
  };
  if (selectedAccountId !== accountId) return null;
  if (query.isError) return <ErrorNotice error={query.error} message="대기 내역을 불러오지 못했습니다." />;
  if (!data) return <Text style={styles.hint}>대기 내역 확인 중…</Text>;
  const pendingGroups = 'groups' in data ? data.groups.filter(g => g.status === 'holding' || g.status === 'active') : [];
  const empty = 'orders' in data ? !data.orders.length : !pendingGroups.length;
  const canMonitor = (domain: 'spot' | 'futures') => 'groups' in data && data.capabilities.enabled && (domain === 'futures' ? data.capabilities.canCreateFutures : data.capabilities.canCreateSpot);
  return <View style={styles.list} testID={protections ? 'pending-protections' : 'pending-futures'}>
    {'groups' in data && !data.capabilities.enabled ? <Text style={styles.hint}>현재 TP/SL 조건 감시가 중지되어 있습니다. 기존 보호 내역을 확인할 수 있습니다.</Text> : null}
    {empty ? <Text style={styles.hint}>{protections ? '대기 중인 TP/SL이 없습니다.' : '대기 중인 선물 진입 주문이 없습니다.'}</Text> : null}
    {'orders' in data ? data.orders.map(o => <View key={o.id} style={styles.card}>
      <Text style={styles.name}>{o.instrument.underlying.name} · {o.instrument.underlying.symbol}</Text>
      <Text style={styles.text}>선물 지정가 · {o.direction === 'long' ? 'Long' : 'Short'} · {o.marginMode === 'cross' ? 'Cross' : 'Isolated'} · {o.leverage}x</Text>
      <Text style={styles.text}>진입 ${formatDisplayDecimal(o.limitPrice)} · 수량 {formatDisplayDecimal(o.quantity)}</Text>
      <Text style={styles.hint}>체결 대기 · 예약 담보 ${formatDisplayDecimal(o.reservedAmount)}</Text>
      <CTAButton label="진입 주문 취소" state={busy ? 'disabled' : 'enabled'} onPress={() => void cancel(o.id)} />
    </View>) : pendingGroups.map(g => <View key={g.id} style={styles.card}>
      <Text style={styles.name}>{g.asset?.name ?? '보호 종목'} · {g.asset?.symbol ?? ''}</Text>
      <Text style={styles.text}>{g.domain === 'spot' ? '현물' : `선물 ${g.direction === 'long' ? 'Long' : 'Short'}`} · {g.status === 'holding' ? '진입 체결 대기' : canMonitor(g.domain) ? '포지션 보호 중' : '보호 감시 중지'}</Text>
      {g.legs.map(leg => <View key={leg.id} style={styles.list}>
        <Text style={styles.text}>{leg.kind === 'stop_loss' ? '손절 SL' : '익절 TP'} · 조건 {formatDisplayDecimal(leg.triggerPrice)} {g.currencyCode}</Text>
        <Text style={styles.text}>{leg.childOrderType === 'market' ? '시장가 실행' : `지정가 ${formatDisplayDecimal(leg.childLimitPrice ?? '0')} ${g.currencyCode}`}</Text>
        <Text style={styles.hint}>{leg.state === 'holding' ? '진입 체결 후 감시' : !canMonitor(g.domain) ? '조건 감시 중지' : leg.state === 'triggered' ? '조건 충족 · 체결 대기' : '조건 감시 중'}</Text>
      </View>)}
      {g.legs.length === 2 ? <Text style={styles.hint}>OCO · 실제 종료 전까지 두 조건을 유지합니다.</Text> : null}
      <CTAButton label="보호 조건 취소" state={busy || !data.capabilities.canCancel ? 'disabled' : 'enabled'} onPress={() => void cancel(g.id)} />
    </View>)}
    {failure ? <ErrorNotice error={failure} message="취소 여부를 확인하지 못했습니다. 같은 요청으로 다시 시도해주세요." /> : null}
  </View>;
}
const styles = StyleSheet.create({ list: { gap: 10, minWidth: 0 }, card: { gap: 8, borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, minWidth: 0 }, name: { fontSize: 17, color: semantic.text, fontWeight: '700', flexShrink: 1 }, text: { fontSize: 14, color: semantic.text, flexShrink: 1 }, hint: { fontSize: 13, color: semantic.secondary, flexShrink: 1 } });
