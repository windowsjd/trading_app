import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ErrorNotice from '../../components/states/ErrorNotice';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getConditionalBuyOrders } from '../../features/conditional/conditionalBuyApi';
import { getConditionalSellOrders } from '../../features/conditional/conditionalSellApi';
import { getAccountEntryTpSlPlans } from '../../features/conditional/entryTpSlApi';
import { getProtectionHistory } from '../../features/conditional/api';
import { getFuturesConditionalEntries } from '../../features/futures/api';
import { getFuturesTpSlSettings } from '../../features/futures/tpSlApi';
import { buildPendingHistory, historyTime, type PendingHistorySources } from '../../features/order/pendingHistory';

const PAGE = 30;
type Part = { label: string; read: (signal?: AbortSignal) => Promise<Partial<PendingHistorySources>> };

/**
 * One 종료 이력 for every pending kind (2026-11-05), read on request: the
 * newest ended rows of each kind together, newest end first. A kind that
 * could not be read is named, never shown as "no history".
 */
async function readHistory(accountId: string, scope: 'all' | 'futures', signal?: AbortSignal) {
  const scoped = <T extends { tradingAccountId: string }>(data: T) => {
    if (data.tradingAccountId !== accountId) throw new Error('ACCOUNT_SCOPE_MISMATCH');
    return data;
  };
  const all: Part[] = [
    { label: '조건부 매수', read: async (s) => ({ conditionalBuys: scoped(await getConditionalBuyOrders(accountId, { state: 'ended', limit: PAGE, offset: 0 }, s)).conditionalOrders }) },
    { label: '조건부 매도·익절가/손절가', read: async (s) => ({
      conditionalSells: [
        ...scoped(await getConditionalSellOrders(accountId, { state: 'ended', kind: 'condition', limit: PAGE, offset: 0 }, s)).conditionalOrders,
        ...scoped(await getConditionalSellOrders(accountId, { state: 'ended', kind: 'protection', limit: PAGE, offset: 0 }, s)).conditionalOrders,
      ],
    }) },
    { label: '선물 조건주문', read: async (s) => ({ futuresConditionals: scoped(await getFuturesConditionalEntries(accountId, 'ended', s)).entries }) },
    { label: '선물 손절가/익절가', read: async (s) => ({ futuresTpSl: scoped(await getFuturesTpSlSettings(accountId, 'ended', s)).settings }) },
    { label: '체결 후 손절가/익절가', read: async (s) => ({ entryPlans: scoped(await getAccountEntryTpSlPlans(accountId, 'ended', s)).plans
      .filter((plan) => scope === 'all' || plan.domain === 'futures') }) },
    { label: '기존 손절가/익절가(OCO)', read: async (s) => {
      const data = scoped(await getProtectionHistory(accountId, s));
      return { protections: 'groups' in data ? data.groups.filter((group) => scope === 'all' || group.domain === 'futures') : [] };
    } },
  ];
  // The futures screen's 종료 이력: its own kinds only.
  const parts = scope === 'futures' ? all.filter((part) => !['조건부 매수', '조건부 매도·익절가/손절가'].includes(part.label)) : all;
  const settled = await Promise.allSettled(parts.map((part) => part.read(signal)));
  const sources: PendingHistorySources = {};
  const failed: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') Object.assign(sources, result.value);
    else failed.push(parts[index].label);
  });
  return { tradingAccountId: accountId, items: buildPendingHistory(sources), failed };
}

export default function PendingHistory({ accountId, isFocused, scope = 'all' }: { accountId: string; isFocused: boolean; scope?: 'all' | 'futures' }) {
  const query = useQuery({
    queryKey: [...QUERY_KEYS.tradingAccount.pendingHistory(accountId), scope],
    queryFn: ({ signal }) => readHistory(accountId, scope, signal),
    enabled: isFocused,
    refetchOnMount: 'always',
    retry: false,
    gcTime: 0,
  });
  const data = query.data?.tradingAccountId === accountId ? query.data : undefined;
  if (query.isError) return <ErrorNotice error={query.error} message="종료 이력을 불러오지 못했어요." />;
  if (!data) return <SectionSkeleton lines={3} />;
  return (
    <View style={styles.list} testID="pending-history">
      <Text style={styles.hint}>유형별 최근 {PAGE}건까지 · 지정가 주문의 체결·취소 내역은 거래 내역에서 확인할 수 있어요.</Text>
      {data.failed.length ? (
        <Text style={styles.warning} testID="pending-history-partial">{data.failed.join(', ')} 이력을 불러오지 못했어요. 다시 열어 확인해 주세요.</Text>
      ) : null}
      {!data.items.length && !data.failed.length ? <Text style={styles.hint}>종료된 대기 설정이 없습니다.</Text> : null}
      {data.items.map((item) => {
        const id = `pending-history-${item.key.replace(':', '-')}`;
        return (
          <View key={item.key} style={styles.card} testID={id}>
            <View style={styles.top}>
              <Text style={styles.name}>{item.assetName}</Text>
              <Text style={styles.state} testID={`${id}-state`}>{item.stateLabel}</Text>
            </View>
            <Text style={styles.meta}>{item.typeLabel} · 종료 {historyTime(item)}</Text>
            {item.reason ? <Text style={styles.hint} testID={`${id}-reason`}>{item.reason}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  list: { gap: 8, minWidth: 0 },
  card: { gap: 4, borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 12, minWidth: 0 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, minWidth: 0 },
  name: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: semantic.text, flexShrink: 1, minWidth: 0 },
  state: { fontSize: 12, lineHeight: 18, fontWeight: '700', color: semantic.secondary, flexShrink: 0, maxWidth: '45%', textAlign: 'right' },
  meta: { fontSize: 13, lineHeight: 19, color: semantic.secondary, flexShrink: 1 },
  hint: { fontSize: 12, lineHeight: 18, color: semantic.muted, flexShrink: 1 },
  warning: { fontSize: 12, lineHeight: 18, color: semantic.warning, flexShrink: 1 },
} as const;
