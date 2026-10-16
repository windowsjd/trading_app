import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import ErrorNotice from '../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  cancelFuturesTpSlSetting,
  getFuturesTpSlSettings,
  type FuturesTpSlSetting,
} from '../../features/futures/tpSlApi';
import {
  cancelEntryTpSlPlan,
  getAccountEntryTpSlPlans,
  type EntryTpSlEntryType,
  type EntryTpSlPlanDto,
} from '../../features/conditional/entryTpSlApi';
import {
  TP_SL_KIND_LABEL,
  formatTpSlQuantity,
  getEntryPlanFailureText,
  getEntryPlanStateLabel,
  getFuturesTpSlStateLabel,
} from '../../features/conditional/tpSlModel';
import TpSlRow from '../../features/conditional/tpsl/TpSlRow';
import { getApiErrorCode, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { formatDisplayDecimal } from '../../utils/format';

const ENTRY_LABEL: Record<EntryTpSlEntryType, string> = {
  spot_limit_order: '현물 지정가 매수',
  spot_conditional_buy: '현물 조건부 매수',
  futures_limit_order: '선물 지정가 진입',
  futures_conditional_entry: '선물 조건주문',
};

/**
 * Independent Futures 손절가/익절가 of the account: live settings with cancel,
 * and on request the newest ended ones (executed, ended with the lifetime,
 * canceled, failed). New settings are registered from a position card.
 */
export function FuturesTpSlList({ accountId, isFocused }: { accountId: string; isFocused: boolean }) {
  const queryClient = useQueryClient();
  const [history, setHistory] = useState(false);
  const open = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.tpSl(accountId, 'open'),
    queryFn: ({ signal }) => getFuturesTpSlSettings(accountId, 'open', signal),
    enabled: isFocused,
    refetchInterval: isFocused ? 4000 : false,
    retry: false,
  });
  const ended = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.tpSl(accountId, 'ended'),
    queryFn: ({ signal }) => getFuturesTpSlSettings(accountId, 'ended', signal),
    enabled: isFocused && history,
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: (row: FuturesTpSlSetting) => cancelFuturesTpSlSetting(accountId, row.id),
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) }),
  });
  const openData = !open.isError && open.data?.tradingAccountId === accountId ? open.data : null;
  const endedRows = !ended.isError && ended.data?.tradingAccountId === accountId ? ended.data.settings : null;
  const row = (setting: FuturesTpSlSetting) => {
    const base = setting.instrument.underlying.symbol.replace(/USDT$/u, '');
    return (
      <TpSlRow key={setting.id} testID={`futures-tp-sl-${setting.id}`}
        title={`${setting.instrument.underlying.name} ${setting.direction === 'long' ? 'Long' : 'Short'} · ${TP_SL_KIND_LABEL[setting.kind]} ${formatDisplayDecimal(setting.triggerPrice)} USD ${setting.triggerCondition === 'at_or_above' ? '이상' : '이하'}`}
        detail={setting.execution
          ? `감소 ${formatTpSlQuantity(setting.execution.quantity)} ${base} · 체결 ${formatDisplayDecimal(setting.execution.executionPrice)} USD`
          : `감소 수량 ${formatTpSlQuantity(setting.quantity)} ${base}`}
        state={getFuturesTpSlStateLabel(setting)}
        cancelLabel={setting.state === 'watching' || setting.state === 'triggered' ? '취소' : null}
        canceling={cancel.isPending && cancel.variables?.id === setting.id}
        onCancel={() => cancel.mutate(setting)} />
    );
  };
  return (
    <View style={styles.list} testID="futures-tp-sl-list">
      <Text accessibilityRole="header" style={styles.heading}>선물 손절가/익절가</Text>
      {open.isError ? <ErrorNotice error={open.error} message="선물 손절가/익절가를 불러오지 못했습니다." />
        : !openData ? <Text style={styles.hint}>확인 중…</Text>
        : openData.settings.length ? openData.settings.map(row)
        : <Text style={styles.hint}>감시 중인 선물 손절가/익절가가 없습니다.</Text>}
      {cancel.isError ? <ErrorNotice error={cancel.error} message={getErrorMessageFromCode(getApiErrorCode(cancel.error))} /> : null}
      <ActionPressable testID="futures-tp-sl-history-toggle" accessibilityRole="button" accessibilityState={{ expanded: history }}
        aria-expanded={history} onPress={() => setHistory((value) => !value)} style={styles.toggle}>
        <Text style={styles.text}>{history ? '종료 이력 닫기' : '종료 이력 보기'}</Text>
      </ActionPressable>
      {history ? ended.isError ? <ErrorNotice error={ended.error} message="종료 이력을 불러오지 못했습니다." />
        : !endedRows ? <Text style={styles.hint}>확인 중…</Text>
        : endedRows.length ? endedRows.map(row)
        : <Text style={styles.hint}>종료된 선물 손절가/익절가가 없습니다.</Text> : null}
    </View>
  );
}

/**
 * 손절가/익절가 plans waiting for their entry's fill, with cancel, and on
 * request the newest ended plans — where an activation that the holding rules
 * refused stays visible with its reason.
 */
export function EntryTpSlPlansList({ accountId, isFocused }: { accountId: string; isFocused: boolean }) {
  const queryClient = useQueryClient();
  const [history, setHistory] = useState(false);
  const open = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.entryTpSl.list(accountId, 'open'),
    queryFn: ({ signal }) => getAccountEntryTpSlPlans(accountId, 'open', signal),
    enabled: isFocused,
    refetchInterval: isFocused ? 4000 : false,
    retry: false,
  });
  const ended = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.entryTpSl.list(accountId, 'ended'),
    queryFn: ({ signal }) => getAccountEntryTpSlPlans(accountId, 'ended', signal),
    enabled: isFocused && history,
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: (plan: EntryTpSlPlanDto) => cancelEntryTpSlPlan(accountId, plan.id),
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.entryTpSl.all(accountId) }),
  });
  const openData = !open.isError && open.data?.tradingAccountId === accountId ? open.data : null;
  const endedRows = !ended.isError && ended.data?.tradingAccountId === accountId ? ended.data.plans : null;
  const row = (plan: EntryTpSlPlanDto) => (
    <TpSlRow key={plan.id} testID={`entry-tp-sl-${plan.id}`}
      title={`${ENTRY_LABEL[plan.entryType]} · ${TP_SL_KIND_LABEL[plan.kind]} ${formatDisplayDecimal(plan.triggerPrice)} ${plan.triggerCondition === 'at_or_above' ? '이상' : '이하'}`}
      detail={plan.activatedQuantity ? `체결 수량의 ${plan.ratioPercent}% · ${formatTpSlQuantity(plan.activatedQuantity)}` : `체결 수량의 ${plan.ratioPercent}%`}
      state={getEntryPlanStateLabel(plan)}
      note={getEntryPlanFailureText(plan)}
      tone={plan.status === 'failed' ? 'warning' : 'normal'}
      cancelLabel={plan.status === 'pending' ? '취소' : null}
      canceling={cancel.isPending && cancel.variables?.id === plan.id}
      onCancel={() => cancel.mutate(plan)} />
  );
  return (
    <View style={styles.list} testID="entry-tp-sl-list">
      <Text accessibilityRole="header" style={styles.heading}>체결 후 활성화 손절가/익절가</Text>
      {open.isError ? <ErrorNotice error={open.error} message="체결 대기 중인 설정을 불러오지 못했습니다." />
        : !openData ? <Text style={styles.hint}>확인 중…</Text>
        : openData.plans.length ? openData.plans.map(row)
        : <Text style={styles.hint}>체결을 기다리는 손절가/익절가가 없습니다.</Text>}
      {cancel.isError ? <ErrorNotice error={cancel.error} message={getErrorMessageFromCode(getApiErrorCode(cancel.error))} /> : null}
      <ActionPressable testID="entry-tp-sl-history-toggle" accessibilityRole="button" accessibilityState={{ expanded: history }}
        aria-expanded={history} onPress={() => setHistory((value) => !value)} style={styles.toggle}>
        <Text style={styles.text}>{history ? '종료 이력 닫기' : '종료 이력 보기'}</Text>
      </ActionPressable>
      {history ? ended.isError ? <ErrorNotice error={ended.error} message="종료 이력을 불러오지 못했습니다." />
        : !endedRows ? <Text style={styles.hint}>확인 중…</Text>
        : endedRows.length ? endedRows.map(row)
        : <Text style={styles.hint}>종료된 설정이 없습니다.</Text> : null}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  list: { gap: 10, minWidth: 0 },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: semantic.text },
  hint: { fontSize: 13, lineHeight: 19, color: semantic.secondary, flexShrink: 1 },
  text: { fontSize: 14, color: semantic.text, flexShrink: 1 },
  toggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
} as const;
