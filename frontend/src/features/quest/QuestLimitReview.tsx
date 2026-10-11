import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { cancelTradingAccountOrder, getTradingAccountOrder } from '../tradingAccount/api';
import { invalidateAfterOrderCancel } from '../tradingAccount/invalidation';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { formatDisplayDecimal } from '../../utils/format';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import QuestTarget from './QuestTarget';
import { useTradingGuideFacts } from './useTradingGuideFacts';

const textValue = (value: unknown) => typeof value === 'string' ? value : '-';

/** Shows the actual registered order, including terminal states absent from pending lists. */
export default function QuestLimitReview({ accountId, orderId, focused }: { accountId: string; orderId: string; focused: boolean }) {
  const client = useQueryClient();
  const mounted = useRef(true), running = useRef(false);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<unknown>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = useQuery({ queryKey: [...QUERY_KEYS.tradingAccount.ordersAll(accountId), 'quest-review', orderId],
    queryFn: () => getTradingAccountOrder(accountId, orderId), enabled: focused,
    refetchOnMount: 'always', refetchInterval: focused ? 2000 : false, retry: false });
  const order = !query.isError && query.data?.tradingAccountId === accountId ? query.data.order : undefined;
  const resolved = order?.status === 'executed' || order?.status === 'canceled' && order.cancelReason === 'user_canceled';
  useTradingGuideFacts({ screen: 'limitReview', accountId, orderResolved: !!resolved }, focused);
  const cancel = async () => {
    if (running.current || !focused || order?.status !== 'submitted') return;
    const session = getSessionGeneration();
    running.current = true; setBusy(true); setFailure(null);
    try {
      await cancelTradingAccountOrder(accountId, orderId);
      if (isCurrentSession(session)) await invalidateAfterOrderCancel(client, accountId);
    } catch (error) { if (mounted.current && isCurrentSession(session)) setFailure(error); }
    finally { running.current = false; if (mounted.current && isCurrentSession(session)) setBusy(false); }
  };
  return <QuestTarget id="limit-review" enabled={focused}><View style={styles.card} testID="quest-limit-review">
    <Text style={styles.title}>실습 주문 상태</Text>
    {query.isError ? <><ErrorNotice error={query.error} /><CTAButton label="주문 상태 다시 확인" onPress={() => void query.refetch()} /></>
      : !order ? <Text>주문 상태 확인 중…</Text> : <>
        <Text>지정가 매수 · {order.status === 'submitted' ? '미체결' : order.status === 'executed' ? '체결' : order.status === 'canceled' ? '취소' : '처리 상태 확인 필요'}</Text>
        <Text>지정가 {formatDisplayDecimal(textValue(order.limitPrice))} · 수량 {formatDisplayDecimal(textValue(order.quantity))}</Text>
        <Text>{order.reservationReleasedAt ? '예약 해제됨' : `예약금 ${formatDisplayDecimal(textValue(order.reservedAmount))}`} {textValue(order.currencyCode)}</Text>
        {order.status === 'executed' ? <Text>실제 체결가 {formatDisplayDecimal(textValue(order.executedPrice))}</Text> : null}
        {order.status === 'submitted' ? <CTAButton label="주문 취소" testID="quest-limit-cancel" variant="secondary" state={busy ? 'loading' : 'enabled'} onPress={() => void cancel()} /> : null}
        {resolved ? <Text>결과를 확인한 뒤 안내의 다음을 눌러 주세요.</Text> : null}
      </>}
    {failure ? <ErrorNotice error={failure} message="취소 결과를 확인하지 못했어요. 주문 상태를 다시 확인해 주세요." /> : null}
  </View></QuestTarget>;
}
const styles = StyleSheet.create({ card: { padding: 16, gap: 10, borderRadius: 12, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface }, title: { fontSize: 17, fontWeight: '700' } });
