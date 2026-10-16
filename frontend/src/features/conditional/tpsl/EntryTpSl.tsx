import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, View } from '../../../theme/native';
import { semantic } from '../../../theme/tokens';
import CTAButton from '../../../components/common/CTAButton';
import ErrorNotice from '../../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../../constants/queryKeys';
import {
  cancelEntryTpSlPlan,
  createEntryTpSlPlans,
  getEntryTpSlPlans,
  type EntryTpSlCreateDto,
  type EntryTpSlEntryDto,
  type EntryTpSlEntryType,
  type EntryTpSlPlanDto,
} from '../entryTpSlApi';
import {
  EMPTY_TP_SL_LEG,
  TP_SL_KINDS,
  TP_SL_KIND_LABEL,
  formatTpSlQuantity,
  getEntryPlanFailureText,
  getEntryPlanStateLabel,
  getTpSlLegError,
  quantityForPercent,
  tpSlCountSummary,
  tpSlWatchesRise,
  type TpSlKind,
  type TpSlLegDraft,
} from '../tpSlModel';
import { useLearningAccess } from '../../quest/useLearningAccess';
import { getApiErrorCode, getApiErrorInfo, getErrorMessageFromCode } from '../../../services/api/errorMapper';
import { createIdempotencyKey } from '../../../utils/idempotency';
import { formatDisplayDecimal } from '../../../utils/format';
import TpSlLegFields from './TpSlLegFields';
import TpSlRow from './TpSlRow';

const BODY_KEY: Record<TpSlKind, 'takeProfit' | 'stopLoss'> = { take_profit: 'takeProfit', stop_loss: 'stopLoss' };
const UNCERTAIN_CREATE = '등록 결과를 확인하지 못했어요. 위 목록을 먼저 확인해 주세요. 같은 내용으로 다시 누르면 중복 없이 다시 확인해요.';
const freshLegs = (): Record<TpSlKind, TpSlLegDraft> => ({ take_profit: EMPTY_TP_SL_LEG, stop_loss: EMPTY_TP_SL_LEG });
type Request = { accountId: string; epoch: number; body: EntryTpSlCreateDto };

/** What the entry is, in one line (its own facts, never a fill). */
export function describeEntry(entry: EntryTpSlEntryDto) {
  const price = (value: string | null) => value ? `${formatDisplayDecimal(value)} ${entry.currencyCode}` : '-';
  const side = entry.domain === 'futures' ? `${entry.direction === 'long' ? 'Long' : 'Short'}${entry.leverage ? ` ${entry.leverage}x` : ''}` : '매수';
  const execution = entry.executionType === 'limit' ? `지정가 ${price(entry.limitPrice)}` : '시장가';
  if (entry.entryType === 'spot_limit_order' || entry.entryType === 'futures_limit_order')
    return `${entry.domain === 'futures' ? '선물 ' : ''}지정가 ${side} · ${price(entry.limitPrice)}`;
  return `${entry.domain === 'futures' ? '선물 ' : ''}조건부 ${side} · 감시가 ${price(entry.triggerPrice)} · 발동 후 ${execution}`;
}

/**
 * 손절가/익절가 of a PENDING entry (BUY Limit, conditional BUY, Futures limit
 * or conditional entry). Each plan is a share of whatever the entry ACTUALLY
 * fills; nothing watches before that fill. The fill turns the plans into
 * independent settings for that share of the filled quantity; an entry that
 * ends unfilled ends them. A conditional entry and the order it created show
 * the same plans.
 */
export default function EntryTpSl({ accountId, entryType, entryId, onBusyChange, onInputFocus, onInputBlur, submitRef }: {
  accountId: string;
  entryType: EntryTpSlEntryType;
  entryId: string;
  onBusyChange: (busy: boolean) => void;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
  submitRef?: React.RefObject<View | null>;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.entryTpSl.entry(accountId, entryType, entryId),
    queryFn: ({ signal }) => getEntryTpSlPlans(accountId, { entryType, entryId }, signal),
    refetchInterval: 4000,
    retry: false,
  });
  const data = query.data?.tradingAccountId === accountId ? query.data : null;
  const entry = data?.entry ?? null;
  const plans = data?.plans ?? [];
  const pendingPlans = plans.filter((plan) => plan.status === 'pending');
  const learning = useLearningAccess(accountId).gate(entry?.domain === 'spot' && entry.asset.assetType === 'crypto' ? 'spotProtection' : 'allTrading');

  const [legs, setLegs] = useState(freshLegs);
  const [registered, setRegistered] = useState<EntryTpSlPlanDto[] | null>(null);
  const [error, setError] = useState<{ cause: unknown; uncertain: boolean } | null>(null);
  const actionRef = useRef<Request | null>(null);
  const scopeRef = useRef({ epoch: 0, mounted: true });
  useEffect(() => {
    const scope = scopeRef.current;
    scope.mounted = true;
    return () => { scope.mounted = false; };
  }, []);
  const isCurrent = (request: Request) => scopeRef.current.mounted && request.epoch === scopeRef.current.epoch;
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.entryTpSl.all(accountId) });

  const mutation = useMutation({
    mutationFn: (request: Request) => createEntryTpSlPlans(request.accountId, request.body),
    retry: false,
    onSuccess: async (result, request) => {
      if (isCurrent(request)) {
        actionRef.current = null;
        setRegistered(result.plans);
        setError(null);
        setLegs(freshLegs());
      }
      await refresh();
    },
    onError: async (cause, request) => {
      if (isCurrent(request)) {
        const info = getApiErrorInfo(cause);
        const uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
        if (!uncertain) actionRef.current = null;
        setError({ cause, uncertain });
      }
      // A fill or cancel may have raced the registration: read the latest state.
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (plan: EntryTpSlPlanDto) => cancelEntryTpSlPlan(accountId, plan.id),
    retry: false,
    onSettled: () => refresh(),
  });
  const pending = mutation.isPending;
  useEffect(() => { onBusyChange(pending || cancel.isPending); }, [cancel.isPending, onBusyChange, pending]);

  const direction = entry?.direction ?? 'long';
  const unit = entry?.domain === 'futures' || entry?.asset.assetType === 'crypto' ? (entry?.asset.symbol ?? '').replace(/USDT$/u, '') : '주';
  const scale = entry?.domain === 'futures' ? 8 : 6;
  const capability = data ? entry?.domain === 'futures' ? data.capabilities.futures : data.capabilities.spot : null;
  const edit = (update: () => void) => {
    if (pending) return;
    update();
    actionRef.current = null;
    scopeRef.current.epoch += 1;
    setRegistered(null);
    setError(null);
  };
  const patch = (kind: TpSlKind, value: Partial<TpSlLegDraft>) =>
    edit(() => setLegs((previous) => ({ ...previous, [kind]: { ...previous[kind], ...value } })));
  const active = TP_SL_KINDS.filter((kind) => legs[kind].enabled);
  const legError = (kind: TpSlKind) => getTpSlLegError({ kind, draft: legs[kind], direction, mode: 'ratio', basis: null, scale,
    existing: pendingPlans, entryPrice: entry?.entryPrice ?? null });
  const draftError = active.length === 0 ? '익절가 또는 손절가 중 하나 이상을 선택해주세요.' : active.map(legError).find((message) => message !== null) ?? null;
  const blockedReason = query.isError && !data ? '주문 정보를 확인하지 못했어요.'
    : !data || !entry ? '주문 정보를 확인하는 중이에요.'
    : !entry.supported ? '이 주문에는 손절가/익절가를 설정할 수 없어요.'
    : entry.state === 'filled' ? '이미 체결된 주문이에요. 보유종목(선물은 포지션)에서 손절가/익절가를 설정해 주세요.'
    : entry.state === 'ended' ? '종료된 주문이라 설정할 수 없어요.'
    : entry.domain === 'spot' && entry.asset.assetType === 'us_stock' ? '미국 주식은 손절가/익절가 설정을 지원하지 않아요.'
    : entry.legacyProtection ? '이 주문에는 기존 TP/SL(OCO) 보호가 연결되어 있어요. 대기 목록의 TP/SL에서 취소한 뒤 설정해 주세요.'
    : !capability?.canCreate ? '현재 손절가/익절가를 새로 등록할 수 없어요.'
    : null;
  const canSubmit = !blockedReason && !draftError && !pending;
  const submit = () => {
    if (!learning.allowed && !actionRef.current) { learning.guard(() => undefined); return; }
    if (!canSubmit && !(actionRef.current && error)) return;
    if (pending || blockedReason || !entry) return;
    setError(null);
    if (!actionRef.current) {
      const leg = (kind: TpSlKind) => ({ triggerPrice: legs[kind].triggerPrice.trim(), ratio: legs[kind].percent });
      actionRef.current = { accountId, epoch: scopeRef.current.epoch, body: {
        // The resolved entry (a conditional entry, never the order it created).
        entryType: entry.entryType, entryId: entry.entryId,
        ...Object.fromEntries(active.map((kind) => [BODY_KEY[kind], leg(kind)])),
        idempotencyKey: createIdempotencyKey('entry_tp_sl'),
      } };
    }
    mutation.mutate(actionRef.current);
  };

  return (
    <View style={styles.body} testID="tp-sl-entry">
      <View style={styles.header}>
        <Text style={styles.name}>{entry ? `${entry.asset.name} · ${entry.asset.symbol}` : '대기 주문'}</Text>
        {entry ? <Text testID="tp-sl-entry-summary" style={styles.helper}>{describeEntry(entry)}</Text> : null}
        {entry ? (
          <Text testID="tp-sl-entry-quantity" style={styles.helper}>
            {entry.expectedQuantity ? `체결 예정 수량 ${formatTpSlQuantity(entry.expectedQuantity, scale)} ${unit}` : `주문 금액 ${formatDisplayDecimal(entry.amount)} ${entry.currencyCode} · 수량은 체결 시 확정`}
          </Text>
        ) : null}
        <Text style={styles.notice}>체결 후 활성화돼요. 실제 체결된 수량에 비율을 적용해요.</Text>
      </View>
      {plans.length ? (
        <View style={styles.list} testID="tp-sl-plans">
          <Text style={styles.section}>설정{tpSlCountSummary(pendingPlans) ? ` · ${tpSlCountSummary(pendingPlans)}` : ''}</Text>
          {plans.map((plan) => (
            <TpSlRow key={plan.id} testID={`tp-sl-plan-${plan.id}`}
              title={`${TP_SL_KIND_LABEL[plan.kind]} · ${formatDisplayDecimal(plan.triggerPrice)} ${entry?.currencyCode ?? ''} ${plan.triggerCondition === 'at_or_above' ? '이상' : '이하'}`}
              detail={plan.status === 'activated' && plan.activatedQuantity
                ? `체결 수량의 ${plan.ratioPercent}% · ${formatTpSlQuantity(plan.activatedQuantity, scale)} ${unit}`
                : `체결 수량의 ${plan.ratioPercent}%`}
              state={getEntryPlanStateLabel(plan)}
              note={getEntryPlanFailureText(plan)}
              tone={plan.status === 'failed' ? 'warning' : 'normal'}
              cancelLabel={plan.status === 'pending' ? '취소' : null}
              canceling={cancel.isPending && cancel.variables?.id === plan.id}
              onCancel={() => cancel.mutate(plan)} />
          ))}
          {cancel.isError ? <ErrorNotice error={cancel.error} message={getErrorMessageFromCode(getApiErrorCode(cancel.error))} testID="tp-sl-cancel-error" /> : null}
        </View>
      ) : null}
      {!entry || entry.state === 'open' ? (
        <TpSlLegFields
          legs={legs}
          onPatch={patch}
          disabled={pending || !!blockedReason}
          ratioDisabled={false}
          currency={entry?.currencyCode ?? ''}
          shareLabel="체결 수량"
          quantityText={(kind, leg) => {
            const expected = quantityForPercent(entry?.expectedQuantity ?? null, leg.percent, scale);
            return `체결 수량의 ${leg.percent}%${expected ? ` · 전량 체결 시 ${formatTpSlQuantity(expected, scale)} ${unit}` : ''}`;
          }}
          error={legError}
          placeholder={(kind) => tpSlWatchesRise(direction, kind) ? '진입 가격보다 높은 가격' : '진입 가격보다 낮은 가격'}
          onInputFocus={onInputFocus}
          onInputBlur={onInputBlur}
        />
      ) : null}
      {blockedReason ? <Text testID="tp-sl-blocked" style={styles.error}>{blockedReason}</Text> : null}
      {error ? (
        <ErrorNotice error={error.cause} message={error.uncertain ? UNCERTAIN_CREATE : getErrorMessageFromCode(getApiErrorCode(error.cause))}
          testID="tp-sl-error" style={styles.error} />
      ) : null}
      {registered ? (
        <Text testID="tp-sl-registered" accessibilityLiveRegion="polite" style={styles.success}>
          {registered.length === 2 ? '익절가와 손절가를 등록했어요.' : `${TP_SL_KIND_LABEL[registered[0]?.kind ?? 'take_profit']}가를 등록했어요.`} 체결되면 활성화돼요.
        </Text>
      ) : null}
      {!entry || entry.state === 'open' ? (
        <View ref={submitRef} collapsable={false}>
          <CTAButton
            testID="tp-sl-submit"
            label={actionRef.current && error ? '같은 내용으로 다시 등록' : '등록하기'}
            state={pending ? 'loading' : canSubmit || (actionRef.current && error && !blockedReason) ? 'enabled' : 'disabled'}
            learningHint={learning.locked ? learning.message : null}
            onPress={submit}
          />
        </View>
      ) : null}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  body: { gap: 12, minWidth: 0 },
  header: { gap: 2, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 23, fontWeight: '700', color: semantic.text, flexShrink: 1 },
  helper: { fontSize: 12, lineHeight: 17, color: semantic.secondary, flexShrink: 1, fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  notice: { fontSize: 12, lineHeight: 17, color: semantic.info, flexShrink: 1 },
  section: { fontSize: 13, lineHeight: 19, fontWeight: '700', color: semantic.text },
  list: { gap: 8, minWidth: 0 },
  error: { fontSize: 12, lineHeight: 17, color: semantic.error },
  success: { fontSize: 13, lineHeight: 19, fontWeight: '600', color: semantic.success },
} as const;
