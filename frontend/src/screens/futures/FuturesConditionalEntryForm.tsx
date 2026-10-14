import { useLearningAccess } from '../../features/quest/useLearningAccess';
import { QUERY_KEYS } from '../../constants/queryKeys';
import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text, View, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import CTAButton from '../../components/common/CTAButton';
import SegmentedControl from '../../components/common/SegmentedControl';
import ErrorNotice from '../../components/states/ErrorNotice';
import OrderNumberInput, { orderInputStyle } from '../order/OrderNumberInput';
import {
  createFuturesConditionalEntry,
  type Direction,
  type FuturesConditionalEntryCommand,
  type FuturesConditionalExecution,
  type FuturesConditionalTrigger,
  type MarginMode,
} from '../../features/futures/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { getApiErrorInfo } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatAssetPrice } from '../../utils/format';

/** The 조건주문 draft the screen keeps (reset with the contract or method). */
export type FuturesConditionalDraft = {
  triggerCondition: FuturesConditionalTrigger;
  triggerPrice: string;
  executionType: FuturesConditionalExecution;
  limitPrice: string;
};
export const emptyFuturesConditionalDraft: FuturesConditionalDraft = {
  triggerCondition: 'at_or_above',
  triggerPrice: '',
  executionType: 'market',
  limitPrice: '',
};

const PRICE = /^\d{1,16}(\.\d{1,8})?$/;
const validPrice = (value: string) => PRICE.test(value) && Number(value) > 0;
const CONDITION_LABEL: Record<FuturesConditionalTrigger, string> = { at_or_above: '이상', at_or_below: '이하' };

/** Whether the current Futures Last already meets the condition (the server refuses it). */
export function futuresConditionAlreadyMet(draft: FuturesConditionalDraft, lastPrice: string | null) {
  if (!lastPrice || !validPrice(draft.triggerPrice)) return false;
  const last = Number(lastPrice), trigger = Number(draft.triggerPrice);
  return draft.triggerCondition === 'at_or_above' ? last >= trigger : last <= trigger;
}

/**
 * 감시 조건 · 감시가격 · 발동 후 실행 · 주문가격: the trigger on Futures Last
 * and how the new position is entered once it fires. Rendered where the other
 * methods show their price field.
 */
export function FuturesConditionalFields({ draft, onChange, disabled, onInputFocus, onInputBlur }: {
  draft: FuturesConditionalDraft; onChange: (draft: FuturesConditionalDraft) => void; disabled: boolean;
  onInputFocus?: (input: View | null) => void; onInputBlur?: () => void;
}) {
  return <View style={styles.fields} testID="futures-conditional-fields">
    <View style={styles.group}>
      <Text style={styles.label}>감시 조건 · 선물 Last 기준</Text>
      <SegmentedControl testID="futures-conditional-trigger" accessibilityLabel="감시 조건" compact value={draft.triggerCondition}
        onChange={(triggerCondition) => onChange({ ...draft, triggerCondition })}
        options={(['at_or_above', 'at_or_below'] as const).map((key) => ({
          key, label: key === 'at_or_above' ? '이상 도달 (≥)' : '이하 도달 (≤)',
          accessibilityLabel: key === 'at_or_above' ? '선물 Last가 감시가격 이상' : '선물 Last가 감시가격 이하',
          testID: `futures-conditional-trigger-${key}`, disabled,
        }))} />
    </View>
    <View style={styles.group}>
      <Text style={styles.label}>감시가격 (USD)</Text>
      <OrderNumberInput accessibilityLabel="선물 조건주문 감시가격" testID="futures-conditional-trigger-price" value={draft.triggerPrice}
        onChangeText={(triggerPrice) => onChange({ ...draft, triggerPrice })} editable={!disabled} keyboardType="decimal-pad"
        placeholder="감시가격 입력" style={styles.input} onFieldFocus={onInputFocus} onBlur={onInputBlur} />
    </View>
    <View style={styles.group}>
      <Text style={styles.label}>발동 후 실행</Text>
      <SegmentedControl testID="futures-conditional-execution" accessibilityLabel="발동 후 실행 방식" compact value={draft.executionType}
        onChange={(executionType) => onChange({ ...draft, executionType, limitPrice: executionType === 'limit' ? draft.limitPrice : '' })}
        options={(['market', 'limit'] as const).map((key) => ({
          key, label: key === 'market' ? '시장가' : '지정가',
          accessibilityLabel: key === 'market' ? '발동 후 시장가 진입' : '발동 후 지정가 진입',
          testID: `futures-conditional-execution-${key}`, disabled,
        }))} />
    </View>
    {draft.executionType === 'limit' ? (
      <View style={styles.group}>
        <Text style={styles.label}>주문가격 · 지정가 (USD)</Text>
        <OrderNumberInput accessibilityLabel="선물 조건주문 지정가" testID="futures-conditional-limit-price" value={draft.limitPrice}
          onChangeText={(limitPrice) => onChange({ ...draft, limitPrice })} editable={!disabled} keyboardType="decimal-pad"
          placeholder="지정가 입력" style={styles.input} onFieldFocus={onInputFocus} onBlur={onInputBlur} />
      </View>
    ) : null}
  </View>;
}

/**
 * 조건주문 (Futures Conditional Entry v1): the screen owns direction, margin
 * mode, leverage, quantity and the draft fields; this form summarizes the
 * watch and owns the idempotent registration. Registering reserves nothing:
 * the existing Futures services check collateral when the order is created.
 */
export default function FuturesConditionalEntryForm({ accountId, instrumentId, direction, marginMode, leverage, quantity, draft, lastPrice, displayDecimals, allowed, onBusy }: {
  accountId: string; instrumentId: string; direction: Direction; marginMode: MarginMode; leverage: string; quantity: string;
  draft: FuturesConditionalDraft; lastPrice: string | null; displayDecimals: number | null; allowed: boolean; onBusy: (busy: boolean) => void;
}) {
  const learning = useLearningAccess(accountId).gate('allTrading');
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [failure, setFailure] = useState<unknown>(null);
  const { selectedAccountId } = useTradingAccount();
  const client = useQueryClient();
  const alive = useRef(true), locked = useRef(false);
  const session = getSessionGeneration();
  const selected = useRef(selectedAccountId); selected.current = selectedAccountId;
  const request = useRef<FuturesConditionalEntryCommand | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const limit = draft.executionType === 'limit';
  const complete = validPrice(draft.triggerPrice) && (!limit || validPrice(draft.limitPrice));
  const alreadyMet = futuresConditionAlreadyMet(draft, lastPrice);
  const ready = allowed && complete && !alreadyMet;
  const permission = useRef(ready);
  permission.current = ready;
  const current = () => alive.current && selected.current === accountId && isCurrentSession(session);
  const price = (value: string) => formatAssetPrice(value, 'USD', displayDecimals);
  const side = direction === 'long' ? '롱(Long)' : '숏(Short)';
  const submit = async () => {
    if (locked.current || !current() || (!uncertain && !permission.current)) return;
    if (!uncertain)
      request.current = {
        instrumentId, direction, marginMode, leverage: Number(leverage), quantity,
        triggerCondition: draft.triggerCondition, triggerPrice: draft.triggerPrice, executionType: draft.executionType,
        ...(limit ? { limitPrice: draft.limitPrice } : {}),
        idempotencyKey: createIdempotencyKey('futures-conditional'),
      };
    if (!request.current) return;
    locked.current = true; setBusy(true); onBusy(true); setFailure(null);
    try {
      await createFuturesConditionalEntry(accountId, request.current);
      if (!current()) return;
      request.current = null; setUncertain(false);
      setMessage('조건주문이 등록되었습니다. 감시 중이며, 담보는 주문이 실행될 때 확인합니다.');
      await client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) });
    } catch (error) {
      if (!current()) return;
      const info = getApiErrorInfo(error); const retry = !info.hasResponse || (info.status ?? 0) >= 500;
      setUncertain(retry); if (!retry) request.current = null;
      setFailure(error);
      setMessage(retry ? '접수 여부를 확인해야 합니다. 동일 요청으로 다시 확인해주세요.' : conditionalErrorMessage(info.serverCode));
    } finally { locked.current = false; if (current()) { setBusy(false); onBusy(!!request.current); } }
  };
  return <View style={styles.stack} testID="futures-conditional-entry">
    <Text style={styles.summary} testID="futures-conditional-summary">
      {validPrice(draft.triggerPrice)
        ? `선물 Last가 ${price(draft.triggerPrice)} ${CONDITION_LABEL[draft.triggerCondition]}가 되면 ${side} ${limit ? (validPrice(draft.limitPrice) ? `${price(draft.limitPrice)} 지정가` : '지정가') : '시장가'}로 새 포지션에 진입합니다.`
        : '감시가격을 입력하면 발동 조건을 확인할 수 있습니다.'}
    </Text>
    <Text style={styles.hint}>등록할 때는 담보를 예약하지 않습니다. 조건이 충족되면 그때의 담보·레버리지·거래 가능 여부를 다시 확인합니다.</Text>
    {alreadyMet ? (
      <Text testID="futures-conditional-already-met" accessibilityLiveRegion="polite" style={styles.error}>
        현재 선물 Last가 이미 조건을 충족합니다. 즉시 실행을 막기 위해 등록할 수 없습니다.
      </Text>
    ) : null}
    <CTAButton testID="futures-conditional-submit" label={uncertain ? '동일 조건주문 요청 확인' : `${side} 조건주문 등록`}
      style={{ backgroundColor: direction === 'long' ? BUY_COLOR : SELL_COLOR }}
      learningHint={learning.locked ? learning.message : null} onPress={() => learning.guard(() => void submit())}
      state={busy ? 'loading' : uncertain || ready ? 'enabled' : 'disabled'} />
    {message ? failure ? <ErrorNotice error={failure} message={message} /> : <Text style={styles.text} accessibilityLiveRegion="polite">{message}</Text> : null}
  </View>;
}

function conditionalErrorMessage(code: string | null) {
  if (code === 'FUTURES_CONDITIONAL_ENTRY_ALREADY_MET')
    return '현재 선물 Last가 이미 조건을 충족해 접수하지 않았습니다. 감시가격을 다시 확인해주세요.';
  if (code === 'FUTURES_CONDITIONAL_ENTRY_PENDING')
    return '이 상품에는 이미 감시 중인 조건주문이 있습니다. 대기 주문에서 확인해주세요.';
  if (code === 'FUTURES_ENTRY_PENDING') return '대기 중인 지정가 진입 주문이 있어 등록할 수 없습니다.';
  if (code === 'FUTURES_POSITION_ALREADY_OPEN') return '보유 포지션이 있어 새 조건주문을 등록할 수 없습니다.';
  if (code === 'FUTURES_CONDITIONAL_ENTRY_LIMIT_EXCEEDED') return '감시 중인 조건주문이 많아 더 등록할 수 없습니다.';
  if (code === 'FUTURES_CONDITIONAL_ENTRY_DISABLED') return '현재 선물 조건주문을 등록할 수 없습니다.';
  if (code === 'FUTURES_PRICE_UNAVAILABLE' || code === 'FUTURES_PRICE_STALE')
    return '현재 선물 Last를 확인할 수 없어 접수하지 않았습니다. 잠시 후 다시 시도해주세요.';
  if (code === 'FUTURES_REDUCE_ONLY' || code === 'FUTURES_TRADING_DISABLED') return '현재 선물 신규 진입이 제한되어 있습니다.';
  return '조건주문을 접수하지 못했습니다. 입력값을 확인해주세요.';
}

const styles = StyleSheet.create({
  fields: { gap: 12, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  stack: { gap: 10, minWidth: 0 },
  label: { color: semantic.muted, fontSize: 12 },
  input: { ...orderInputStyle },
  summary: { color: semantic.text, fontSize: 14, lineHeight: 21, fontWeight: '600', flexShrink: 1 },
  text: { color: semantic.text, fontSize: 14, flexShrink: 1 },
  hint: { color: semantic.secondary, fontSize: 12, lineHeight: 18, flexShrink: 1 },
  error: { color: semantic.error, fontSize: 12, lineHeight: 18, flexShrink: 1 },
});
