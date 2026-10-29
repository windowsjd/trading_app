import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, View } from '../../../theme/native';
import { semantic } from '../../../theme/tokens';
import CTAButton from '../../../components/common/CTAButton';
import ErrorNotice from '../../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../../constants/queryKeys';
import { cancelProtection, getProtections } from '../api';
import { getFuturesPositions } from '../../futures/api';
import { futuresServerNow } from '../../futures/policy';
import { futuresHolding, getFuturesPositionDisplay } from '../../futures/positionDisplay';
import FuturesPositionSheetSummary from '../../../components/tradingAccount/FuturesPositionSheetSummary';
import {
  cancelFuturesTpSlSetting,
  createFuturesTpSlSettings,
  getFuturesTpSlSettings,
  type FuturesTpSlCommand,
  type FuturesTpSlSetting,
} from '../../futures/tpSlApi';
import {
  EMPTY_TP_SL_LEG,
  TP_SL_KINDS,
  TP_SL_KIND_LABEL,
  formatTpSlQuantity,
  getFuturesTpSlStateLabel,
  getTpSlLegError,
  isTpSlAlreadyMet,
  quantityForPercent,
  tpSlCountSummary,
  tpSlWatchesRise,
  type TpSlKind,
  type TpSlLegDraft,
} from '../tpSlModel';
import { useLearningAccess } from '../../quest/useLearningAccess';
import { getApiErrorCode, getApiErrorInfo, getErrorMessageFromCode } from '../../../services/api/errorMapper';
import { createIdempotencyKey } from '../../../utils/idempotency';
import { formatDisplayDecimal, formatMoneyDecimal } from '../../../utils/format';
import TpSlLegFields from './TpSlLegFields';
import TpSlRow from './TpSlRow';

const BODY_KEY: Record<TpSlKind, 'takeProfit' | 'stopLoss'> = { take_profit: 'takeProfit', stop_loss: 'stopLoss' };
const UNCERTAIN_CREATE = '등록 결과를 확인하지 못했어요. 위 목록을 먼저 확인해 주세요. 같은 내용으로 다시 누르면 중복 없이 다시 확인해요.';
const freshLegs = (): Record<TpSlKind, TpSlLegDraft> => ({ take_profit: EMPTY_TP_SL_LEG, stop_loss: EMPTY_TP_SL_LEG });
type Request = { accountId: string; epoch: number; body: FuturesTpSlCommand };

/**
 * 손절가/익절가 of one open Futures position: independent settings on THIS
 * lifetime, each a Futures Last trigger and a share of the position fixed
 * into a quantity when registered. A reached setting reduces the position
 * (or closes the remainder) at Futures Last through the ordinary execution;
 * it never opens, increases or flips anything, and never cancels the other
 * settings. Mark stays the risk price: a stop-loss does not prevent a
 * liquidation. A legacy whole-position OCO group on the lifetime is shown
 * with its cancel; new settings wait until it is gone.
 */
export default function FuturesPositionTpSl({ accountId, positionId, onBusyChange, onInputFocus, onInputBlur, submitRef }: {
  accountId: string;
  positionId: string;
  onBusyChange: (busy: boolean) => void;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
  submitRef?: React.RefObject<View | null>;
}) {
  const queryClient = useQueryClient();
  const positionsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.positions(accountId),
    queryFn: ({ signal }) => getFuturesPositions(accountId, signal),
    refetchInterval: 4000,
  });
  const position = positionsQuery.data?.tradingAccountId === accountId
    ? positionsQuery.data.positions.find((row) => row.id === positionId) ?? null : null;
  // Mark Price as the position's card shows it: only while fresh.
  const markFresh = !!position && !!positionsQuery.data && getFuturesPositionDisplay(futuresHolding(position),
    positionsQuery.data.evaluatedAt, futuresServerNow(positionsQuery.data, Date.now())).fresh;
  const settingsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.tpSl(accountId, 'open'),
    queryFn: ({ signal }) => getFuturesTpSlSettings(accountId, 'open', signal),
    refetchInterval: 4000,
  });
  const settingsData = settingsQuery.data?.tradingAccountId === accountId ? settingsQuery.data : null;
  const settings = (settingsData?.settings ?? []).filter((row) => row.positionId === positionId);
  const assetId = position?.instrument.underlying.assetId ?? '';
  const ocoQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.protections.list(accountId, 'futures', assetId),
    queryFn: ({ signal }) => getProtections(accountId, 'futures', assetId, false, signal),
    enabled: !!assetId,
    retry: false,
  });
  const oco = !ocoQuery.isError && ocoQuery.data?.tradingAccountId === accountId
    ? ocoQuery.data.groups.find((group) => (group.status === 'active' || group.status === 'holding') && group.positionId === positionId) ?? null
    : null;
  const learning = useLearningAccess(accountId).gate('allTrading');

  const [legs, setLegs] = useState(freshLegs);
  const [registered, setRegistered] = useState<FuturesTpSlSetting[] | null>(null);
  const [error, setError] = useState<{ cause: unknown; uncertain: boolean } | null>(null);
  const actionRef = useRef<Request | null>(null);
  const ocoCancelKey = useRef<string | null>(null);
  const scopeRef = useRef({ epoch: 0, mounted: true });
  useEffect(() => {
    const scope = scopeRef.current;
    scope.mounted = true;
    return () => { scope.mounted = false; };
  }, []);
  const isCurrent = (request: Request) => scopeRef.current.mounted && request.epoch === scopeRef.current.epoch;
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) });

  const mutation = useMutation({
    mutationFn: (request: Request) => createFuturesTpSlSettings(request.accountId, request.body),
    retry: false,
    onSuccess: async (result, request) => {
      if (isCurrent(request)) {
        actionRef.current = null;
        setRegistered(result.settings);
        setError(null);
        setLegs(freshLegs());
      }
      await refresh();
    },
    onError: (cause, request) => {
      if (!isCurrent(request)) return;
      const info = getApiErrorInfo(cause);
      const uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
      if (!uncertain) actionRef.current = null;
      setError({ cause, uncertain });
    },
  });
  const cancel = useMutation({
    mutationFn: (row: FuturesTpSlSetting) => cancelFuturesTpSlSetting(accountId, row.id),
    retry: false,
    onSettled: () => refresh(),
  });
  const cancelOco = useMutation({
    mutationFn: (groupId: string) => {
      ocoCancelKey.current ??= createIdempotencyKey('protection-cancel');
      return cancelProtection(accountId, groupId, ocoCancelKey.current);
    },
    retry: false,
    onSuccess: () => { ocoCancelKey.current = null; },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.protections.all(accountId) }),
  });
  const pending = mutation.isPending;
  useEffect(() => { onBusyChange(pending || cancel.isPending || cancelOco.isPending); },
    [cancel.isPending, cancelOco.isPending, onBusyChange, pending]);

  const quantity = position?.quantity ?? null;
  const direction = position?.direction ?? 'long';
  const base = (position?.instrument.underlying.symbol ?? '').replace(/USDT$/u, '');
  const last = position?.referencePrice ?? null;
  const notional = (value: string | null) => {
    if (!value || !last) return null;
    const amount = Number(value) * Number(last);
    return Number.isFinite(amount) ? amount.toFixed(2) : null;
  };
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
  const legError = (kind: TpSlKind) => getTpSlLegError({ kind, draft: legs[kind], direction, mode: 'quantity', basis: quantity, scale: 8, existing: settings });
  const draftError = active.length === 0 ? '익절가 또는 손절가 중 하나 이상을 선택해주세요.' : active.map(legError).find((message) => message !== null) ?? null;
  const blockedReason = !position
    ? positionsQuery.isError ? '포지션을 확인하지 못했어요.' : positionsQuery.data ? '이 포지션은 이미 종료됐어요.' : '포지션을 확인하는 중이에요.'
    : settingsQuery.isError && !settingsData ? '등록된 설정을 확인하지 못했어요.'
    : !settingsData ? '등록된 설정을 확인하는 중이에요.'
    : !settingsData.capabilities.canCreate ? '현재 선물 손절가/익절가를 새로 등록할 수 없어요.'
    : oco ? '이 포지션에는 기존 TP/SL(OCO) 보호가 있어 함께 설정할 수 없어요. 아래에서 기존 보호를 취소한 뒤 등록해 주세요.'
    : null;
  const canSubmit = !blockedReason && !draftError && !pending;
  const submit = () => {
    if (!learning.allowed && !actionRef.current) { learning.guard(() => undefined); return; }
    if (!canSubmit && !(actionRef.current && error)) return;
    if (pending || blockedReason) return;
    setError(null);
    if (!actionRef.current) {
      const leg = (kind: TpSlKind) => ({ triggerPrice: legs[kind].triggerPrice.trim(), quantity: quantityForPercent(quantity, legs[kind].percent, 8) ?? '' });
      actionRef.current = { accountId, epoch: scopeRef.current.epoch, body: {
        positionId,
        ...Object.fromEntries(active.map((kind) => [BODY_KEY[kind], leg(kind)])),
        idempotencyKey: createIdempotencyKey('futures_tp_sl'),
      } };
    }
    mutation.mutate(actionRef.current);
  };

  const live = settings.filter((row) => row.state === 'watching' || row.state === 'triggered');
  return (
    <View style={styles.body} testID="tp-sl-futures-position">
      {/* The position sheets' shared top (as 포지션 종료): contract, side, 진입가, Mark Price. */}
      {position ? <FuturesPositionSheetSummary testID="tp-sl-summary" position={position} markFresh={markFresh} />
        : <Text style={styles.name}>선물 포지션</Text>}
      <View style={styles.header}>
        <Text testID="tp-sl-position" style={styles.helper}>
          포지션 수량 {quantity ? `${formatDisplayDecimal(quantity)} ${base}` : '-'}
          {notional(quantity) ? ` · 명목금액 약 ${formatMoneyDecimal(notional(quantity), 'USD')}` : ''}
        </Text>
        <Text style={styles.helper}>선물 Last 기준으로 감시하고 포지션을 줄여요. 손절가가 강제청산을 막지는 않아요.</Text>
      </View>
      {oco ? (
        <View testID="tp-sl-legacy-oco" style={styles.legacy}>
          <Text style={styles.section}>기존 TP/SL(OCO)</Text>
          {oco.legs.map((leg) => (
            <Text key={leg.id} style={styles.helper}>{TP_SL_KIND_LABEL[leg.kind]} · {formatDisplayDecimal(leg.triggerPrice)} USD · 포지션 전체</Text>
          ))}
          <CTAButton testID="tp-sl-legacy-oco-cancel" variant="secondary" label={cancelOco.isPending ? '취소 중...' : '기존 TP/SL(OCO) 취소'}
            state={cancelOco.isPending ? 'loading' : ocoQuery.data?.capabilities.canCancel ? 'enabled' : 'disabled'}
            onPress={() => cancelOco.mutate(oco.id)} />
          {cancelOco.isError ? <ErrorNotice error={cancelOco.error} message="기존 보호의 취소 결과를 확인하지 못했어요. 다시 시도해 주세요." /> : null}
        </View>
      ) : null}
      {settings.length ? (
        <View style={styles.list} testID="tp-sl-live">
          <Text style={styles.section}>등록된 설정{tpSlCountSummary(live) ? ` · ${tpSlCountSummary(live)}` : ''}</Text>
          {settings.map((row) => (
            <TpSlRow key={row.id} testID={`tp-sl-setting-${row.id}`}
              title={`${TP_SL_KIND_LABEL[row.kind]} · ${formatDisplayDecimal(row.triggerPrice)} USD ${row.triggerCondition === 'at_or_above' ? '이상' : '이하'}`}
              detail={`감소 수량 ${formatTpSlQuantity(row.quantity)} ${base}${row.position?.executableQuantity && row.position.executableQuantity !== row.quantity ? ` (지금 실행 시 ${formatTpSlQuantity(row.position.executableQuantity)})` : ''}`}
              state={getFuturesTpSlStateLabel(row)}
              cancelLabel={row.state === 'watching' || row.state === 'triggered' ? '취소' : null}
              canceling={cancel.isPending && cancel.variables?.id === row.id}
              onCancel={() => cancel.mutate(row)} />
          ))}
          {cancel.isError ? <ErrorNotice error={cancel.error} message={getErrorMessageFromCode(getApiErrorCode(cancel.error))} testID="tp-sl-cancel-error" /> : null}
        </View>
      ) : null}
      <TpSlLegFields
        legs={legs}
        onPatch={patch}
        disabled={pending || !!blockedReason}
        ratioDisabled={quantity === null}
        currency="USD"
        shareLabel="포지션 수량"
        quantityText={(kind, leg) => {
          const amount = quantityForPercent(quantity, leg.percent, 8);
          const value = notional(amount);
          return `감소 수량 ${amount ? `${formatTpSlQuantity(amount)} ${base}` : '-'}${value ? ` · 약 ${formatMoneyDecimal(value, 'USD')}` : ''}`;
        }}
        error={legError}
        warning={(kind) => isTpSlAlreadyMet(direction, kind, legs[kind].triggerPrice, last)
          ? '현재 선물 Last가 이미 이 가격에 도달해 등록되지 않을 수 있어요.' : null}
        placeholder={(kind) => tpSlWatchesRise(direction, kind) ? '현재가보다 높은 가격' : '현재가보다 낮은 가격'}
        onInputFocus={onInputFocus}
        onInputBlur={onInputBlur}
      />
      {blockedReason ? <Text testID="tp-sl-blocked" style={styles.error}>{blockedReason}</Text> : null}
      {error ? (
        <ErrorNotice error={error.cause} message={error.uncertain ? UNCERTAIN_CREATE : getErrorMessageFromCode(getApiErrorCode(error.cause))}
          testID="tp-sl-error" style={styles.error} />
      ) : null}
      {registered ? (
        <Text testID="tp-sl-registered" accessibilityLiveRegion="polite" style={styles.success}>
          {registered.length === 2 ? '익절가와 손절가를 등록했어요.' : `${TP_SL_KIND_LABEL[registered[0]?.kind ?? 'take_profit']}가를 등록했어요.`}
        </Text>
      ) : null}
      <View ref={submitRef} collapsable={false}>
        <CTAButton
          testID="tp-sl-submit"
          label={actionRef.current && error ? '같은 내용으로 다시 등록' : '등록하기'}
          state={pending ? 'loading' : canSubmit || (actionRef.current && error && !blockedReason) ? 'enabled' : 'disabled'}
          learningHint={learning.locked ? learning.message : null}
          onPress={submit}
        />
      </View>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  body: { gap: 12, minWidth: 0 },
  header: { gap: 2, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 23, fontWeight: '700', color: semantic.text, flexShrink: 1 },
  helper: { fontSize: 12, lineHeight: 17, color: semantic.secondary, flexShrink: 1, fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  section: { fontSize: 13, lineHeight: 19, fontWeight: '700', color: semantic.text },
  list: { gap: 8, minWidth: 0 },
  legacy: { gap: 6, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: semantic.border, minWidth: 0 },
  error: { fontSize: 12, lineHeight: 17, color: semantic.error },
  success: { fontSize: 13, lineHeight: 19, fontWeight: '600', color: semantic.success },
} as const;
