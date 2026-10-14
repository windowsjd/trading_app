import { QUERY_KEYS } from '../../constants/queryKeys';
import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import {
  cancelFuturesConditionalEntry,
  cancelFuturesLimitOrder,
  getFuturesConditionalEntries,
  type FuturesConditionalEntry,
} from '../../features/futures/api';
import {
  FUTURES_CONDITION_SIGN,
  getFuturesConditionalCancelPath,
  getFuturesConditionalEndReason,
  getFuturesConditionalStateLabel,
} from '../../features/futures/conditionalEntryDisplay';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { formatAssetPrice, formatDisplayDecimal, formatKstDateTime, formatUsd } from '../../utils/format';
import { invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation';

/**
 * The account's Futures conditional entries with their real state: open rows
 * (watching, triggered, a created limit entry still pending) first and in
 * full, then the newest ended rows. A watch is canceled while watching or
 * triggered; once it created a limit entry, that entry is canceled instead.
 * Read and cancel stay available while new registrations are switched off.
 */
export default function FuturesConditionalEntriesList({ accountId, isFocused, seasonUi }: {
  accountId: string; isFocused: boolean; seasonUi: boolean;
}) {
  const { selectedAccountId } = useTradingAccount();
  const client = useQueryClient();
  const bound = selectedAccountId === accountId;
  const open = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.conditionalEntries(accountId, 'open'),
    queryFn: ({ signal }) => getFuturesConditionalEntries(accountId, 'open', signal),
    enabled: isFocused && bound, refetchInterval: isFocused ? 4000 : false, retry: false,
  });
  const ended = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.conditionalEntries(accountId, 'ended'),
    queryFn: ({ signal }) => getFuturesConditionalEntries(accountId, 'ended', signal),
    enabled: isFocused && bound, refetchInterval: isFocused ? 15000 : false, retry: false,
  });
  const [failure, setFailure] = useState<unknown>(null), [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true), locked = useRef(false), selected = useRef(selectedAccountId);
  selected.current = selectedAccountId;
  const session = getSessionGeneration();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && selected.current === accountId && isCurrentSession(session);
  // Never another account's rows (account switch, late responses).
  const openRows = !open.isError && open.data?.tradingAccountId === accountId ? open.data.entries : undefined;
  const endedRows = !ended.isError && ended.data?.tradingAccountId === accountId ? ended.data.entries : undefined;
  const openIds = openRows?.map((row) => `${row.id}:${row.state}`).join(',');
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    // A trigger can open a position or reserve collateral: refresh what depends on it.
    if (openIds !== undefined && previous.current !== undefined && openIds !== previous.current) {
      void client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) });
      void invalidateAfterOrderCreate(client, accountId, { seasonUi });
    }
    if (openIds !== undefined) previous.current = openIds;
  }, [openIds, accountId, client, seasonUi]);
  const cancel = async (row: FuturesConditionalEntry) => {
    const path = getFuturesConditionalCancelPath(row);
    if (!path || locked.current || !isFocused || !current()) return;
    locked.current = true; setBusy(row.id); setFailure(null);
    try {
      if (path.kind === 'entry') await cancelFuturesConditionalEntry(accountId, row.id);
      else await cancelFuturesLimitOrder(accountId, path.orderId);
      if (!current()) return;
      await Promise.all([
        client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) }),
        invalidateAfterOrderCreate(client, accountId, { seasonUi }),
      ]);
    } catch (error) { if (current()) setFailure(error); }
    finally { locked.current = false; if (current()) setBusy(null); }
  };
  if (!bound) return null;
  if (open.isError) return <ErrorNotice error={open.error} message="선물 조건주문을 불러오지 못했습니다." />;
  if (!openRows) return <Text style={styles.hint}>선물 조건주문 확인 중…</Text>;
  const capabilities = open.data?.capabilities;
  return <View style={styles.list} testID="futures-conditional-entries">
    <Text accessibilityRole="header" style={styles.heading}>선물 조건주문</Text>
    {capabilities && !capabilities.enabled ? (
      <Text style={styles.hint}>현재 새 선물 조건주문은 등록할 수 없습니다. 기존 조건주문은 확인하고 취소할 수 있습니다.</Text>
    ) : null}
    {!openRows.length ? <Text style={styles.hint}>감시 중인 선물 조건주문이 없습니다.</Text> : null}
    {openRows.map((row) => <EntryRow key={row.id} row={row} busy={busy !== null} onCancel={() => void cancel(row)} />)}
    {failure ? <ErrorNotice error={failure} message="취소 여부를 확인하지 못했습니다. 최신 상태를 확인한 뒤 다시 시도해주세요." /> : null}
    {ended.isError ? <ErrorNotice error={ended.error} message="종료된 선물 조건주문을 불러오지 못했습니다." /> : null}
    {endedRows?.length ? <>
      <Text style={styles.subheading}>최근 종료</Text>
      {endedRows.map((row) => <EntryRow key={row.id} row={row} busy={false} onCancel={() => undefined} />)}
    </> : null}
  </View>;
}

function EntryRow({ row, busy, onCancel }: { row: FuturesConditionalEntry; busy: boolean; onCancel: () => void }) {
  const price = (value: string) => formatAssetPrice(value, 'USD', row.instrument.underlying.displayPriceDecimals);
  const path = getFuturesConditionalCancelPath(row);
  const reason = getFuturesConditionalEndReason(row);
  const long = row.direction === 'long';
  return <View style={styles.card} testID={`futures-conditional-${row.id}`}>
    <View style={styles.header}>
      <Text style={[styles.direction, { color: long ? BUY_COLOR : SELL_COLOR }]}>{long ? '롱(Long)' : '숏(Short)'}</Text>
      <Text style={styles.name}>{row.instrument.underlying.name} · {row.instrument.underlying.symbol}</Text>
    </View>
    <Text testID={`futures-conditional-${row.id}-state`} style={styles.state}>{getFuturesConditionalStateLabel(row)}</Text>
    <Text style={styles.text}>
      선물 Last {FUTURES_CONDITION_SIGN[row.triggerCondition]} {price(row.triggerPrice)} → {row.executionType === 'market' ? '시장가 진입' : `${price(row.limitPrice ?? '0')} 지정가 진입`}
    </Text>
    <Text style={styles.text}>
      수량 {formatDisplayDecimal(row.quantity)} · {row.marginMode === 'cross' ? '교차' : '격리'} {row.leverage}x
    </Text>
    {row.execution ? (
      <Text style={styles.hint}>체결 {price(row.execution.executionPrice)} · 수수료 ${formatUsd(row.execution.feeAmount)}</Text>
    ) : null}
    {row.limitOrder?.status === 'submitted' ? (
      <Text style={styles.hint}>지정가 주문 체결 대기 · 예약 담보 ${formatDisplayDecimal(row.limitOrder.reservedAmount)}</Text>
    ) : null}
    {reason ? <Text style={styles.hint}>{reason}</Text> : null}
    <Text style={styles.hint}>등록 {formatKstDateTime(row.createdAt)}{row.trigger ? ` · 발동 ${formatKstDateTime(row.trigger.triggeredAt)}` : ''}</Text>
    {path ? (
      <CTAButton variant="secondary" testID={`futures-conditional-${row.id}-cancel`}
        label={path.kind === 'entry' ? '조건주문 취소' : '지정가 주문 취소'} state={busy ? 'disabled' : 'enabled'} onPress={onCancel} />
    ) : null}
  </View>;
}

const styles = StyleSheet.create({
  list: { gap: 10, minWidth: 0 },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: semantic.text },
  subheading: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.secondary },
  card: { gap: 6, borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, minWidth: 0 },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2, minWidth: 0 },
  direction: { fontSize: 13, lineHeight: 20, fontWeight: '800' },
  name: { fontSize: 16, lineHeight: 24, color: semantic.text, fontWeight: '700', flexShrink: 1, minWidth: 0 },
  state: { fontSize: 14, lineHeight: 21, color: semantic.text, fontWeight: '600', flexShrink: 1 },
  text: { fontSize: 14, lineHeight: 21, color: semantic.text, flexShrink: 1 },
  hint: { fontSize: 13, lineHeight: 19, color: semantic.secondary, flexShrink: 1 },
});
