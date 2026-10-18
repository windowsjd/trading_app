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
import { getApiErrorInfo, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatAssetPrice } from '../../utils/format';
import {
  TRIGGER_DIRECTION_LABEL,
  getTriggerDirectionText,
  isTriggerDirectionValid,
  resolveTriggerDirection,
  triggerDirectionChangedText,
  type TriggerDirection,
} from '../../features/conditional/autoDirection';

/**
 * The 조건주문 draft the screen keeps (reset with the contract or method).
 * `triggerCondition` is the 이상/이하 decided for this watch price against a
 * fresh Futures Last — null until one decides it; never chosen by hand.
 */
export type FuturesConditionalDraft = {
  triggerCondition: FuturesConditionalTrigger | null;
  triggerPrice: string;
  executionType: FuturesConditionalExecution;
  limitPrice: string;
};
export const emptyFuturesConditionalDraft: FuturesConditionalDraft = {
  triggerCondition: null,
  triggerPrice: '',
  executionType: 'market',
  limitPrice: '',
};

const PRICE = /^\d{1,16}(\.\d{1,8})?$/;
const validPrice = (value: string) => PRICE.test(value) && Number(value) > 0;
const LAST = '선물 Last';

function decided(triggerPrice: string, lastPrice: string | null): FuturesConditionalTrigger | null {
  const direction = resolveTriggerDirection(triggerPrice, lastPrice);
  return direction.state === 'ready' ? direction.condition : null;
}

/**
 * 감시가격 · 발동 후 실행 · 주문가격: the trigger on Futures Last and how the
 * new position is entered once it fires. Rendered where the other methods
 * show their price field. 이상/이하 follows the watch price against the
 * fresh Futures Last when it is entered; a later move never flips it.
 */
export function FuturesConditionalFields({ draft, onChange, lastPrice, disabled, onInputFocus, onInputBlur }: {
  draft: FuturesConditionalDraft; onChange: (draft: FuturesConditionalDraft) => void;
  /** The fresh Futures Last; null when stale or unknown. */
  lastPrice: string | null;
  disabled: boolean;
  onInputFocus?: (input: View | null) => void; onInputBlur?: () => void;
}) {
  const live = resolveTriggerDirection(draft.triggerPrice, lastPrice);
  const liveCondition = live.state === 'ready' ? live.condition : null;
  // A watch price typed while Last was unknown is decided once Last arrives.
  useEffect(() => {
    if (!draft.triggerCondition && liveCondition) onChange({ ...draft, triggerCondition: liveCondition });
  }, [draft, liveCondition, onChange]);
  const direction: TriggerDirection = draft.triggerCondition ? { state: 'ready', condition: draft.triggerCondition } : live;
  const directionText = getTriggerDirectionText(direction, draft.triggerPrice, 'USD', LAST);
  return <View style={styles.fields} testID="futures-conditional-fields">
    <View style={styles.group}>
      <Text style={styles.label}>감시가격 (USD) · 선물 Last 기준</Text>
      <OrderNumberInput accessibilityLabel="선물 조건주문 감시가격" testID="futures-conditional-trigger-price" value={draft.triggerPrice}
        onChangeText={(triggerPrice) => onChange({ ...draft, triggerPrice, triggerCondition: decided(triggerPrice, lastPrice) })}
        editable={!disabled} keyboardType="decimal-pad"
        placeholder="감시가격 입력" style={styles.input} onFieldFocus={onInputFocus} onBlur={onInputBlur} />
      {directionText ? (
        <Text testID="futures-conditional-trigger-direction" accessibilityLiveRegion="polite"
          style={direction.state === 'ready' ? styles.direction : styles.error}>
          {direction.state === 'ready' ? `감시 조건 · ${LAST} ${directionText}` : directionText}
        </Text>
      ) : null}
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
 * Before sending, the decided 이상/이하 is checked against the latest Last;
 * when it no longer holds it is decided again and the user confirms again.
 */
export default function FuturesConditionalEntryForm({ accountId, instrumentId, direction, marginMode, leverage, quantity, draft, onDraftChange, lastPrice, displayDecimals, allowed, onBusy }: {
  accountId: string; instrumentId: string; direction: Direction; marginMode: MarginMode; leverage: string; quantity: string;
  draft: FuturesConditionalDraft; onDraftChange: (update: (draft: FuturesConditionalDraft) => FuturesConditionalDraft) => void;
  lastPrice: string | null; displayDecimals: number | null; allowed: boolean; onBusy: (busy: boolean) => void;
}) {
  const learning = useLearningAccess(accountId).gate('allTrading');
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [failure, setFailure] = useState<unknown>(null);
  // Shown only while the watch price it was about stays unchanged.
  const [directionNotice, setDirectionNotice] = useState<{ triggerPrice: string; text: string } | null>(null);
  const { selectedAccountId } = useTradingAccount();
  const client = useQueryClient();
  const alive = useRef(true), locked = useRef(false);
  const session = getSessionGeneration();
  const selected = useRef(selectedAccountId); selected.current = selectedAccountId;
  const request = useRef<FuturesConditionalEntryCommand | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const limit = draft.executionType === 'limit';
  const condition = draft.triggerCondition;
  const complete = validPrice(draft.triggerPrice) && (!limit || validPrice(draft.limitPrice)) && !!condition;
  // Last moved past the watch price after its direction was decided.
  const crossed = !!condition && !!lastPrice && !isTriggerDirectionValid(condition, draft.triggerPrice, lastPrice);
  const ready = allowed && complete;
  const permission = useRef(ready);
  permission.current = ready;
  const current = () => alive.current && selected.current === accountId && isCurrentSession(session);
  const price = (value: string) => formatAssetPrice(value, 'USD', displayDecimals);
  const side = direction === 'long' ? '롱(Long)' : '숏(Short)';
  const submit = async () => {
    if (locked.current || !current() || (!uncertain && !permission.current)) return;
    if (!uncertain) {
      // Never send a direction the latest Futures Last no longer supports.
      if (!condition || !isTriggerDirectionValid(condition, draft.triggerPrice, lastPrice)) {
        const next = resolveTriggerDirection(draft.triggerPrice, lastPrice);
        const triggerPrice = draft.triggerPrice;
        onDraftChange((previous) => previous.triggerPrice === triggerPrice
          ? { ...previous, triggerCondition: next.state === 'ready' ? next.condition : null } : previous);
        setMessage(null); setFailure(null);
        setDirectionNotice({ triggerPrice, text: next.state === 'ready'
          ? triggerDirectionChangedText(LAST) : getTriggerDirectionText(next, triggerPrice, 'USD', LAST) ?? triggerDirectionChangedText(LAST) });
        return;
      }
      request.current = {
        instrumentId, direction, marginMode, leverage: Number(leverage), quantity,
        triggerCondition: condition, triggerPrice: draft.triggerPrice, executionType: draft.executionType,
        ...(limit ? { limitPrice: draft.limitPrice } : {}),
        idempotencyKey: createIdempotencyKey('futures-conditional'),
      };
    }
    if (!request.current) return;
    setDirectionNotice(null);
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
      // The server's Last had already crossed: decide again from the latest Last.
      if (info.serverCode === 'FUTURES_CONDITIONAL_ENTRY_ALREADY_MET') {
        const triggerPrice = request.current?.triggerPrice;
        onDraftChange((previous) => previous.triggerPrice === triggerPrice ? { ...previous, triggerCondition: null } : previous);
      }
      setUncertain(retry); if (!retry) request.current = null;
      setFailure(error);
      setMessage(retry ? '접수 여부를 확인해야 합니다. 동일 요청으로 다시 확인해주세요.' : conditionalErrorMessage(info.serverCode));
    } finally { locked.current = false; if (current()) { setBusy(false); onBusy(!!request.current); } }
  };
  return <View style={styles.stack} testID="futures-conditional-entry">
    <Text style={styles.summary} testID="futures-conditional-summary">
      {validPrice(draft.triggerPrice) && condition
        ? `선물 Last가 ${price(draft.triggerPrice)} ${TRIGGER_DIRECTION_LABEL[condition]}가 되면 ${side} ${limit ? (validPrice(draft.limitPrice) ? `${price(draft.limitPrice)} 지정가` : '지정가') : '시장가'}로 새 포지션에 진입합니다.`
        : '감시가격을 입력하면 발동 조건을 확인할 수 있습니다.'}
    </Text>
    <Text style={styles.hint}>등록할 때는 담보를 예약하지 않습니다.</Text>
    {crossed ? (
      <Text testID="futures-conditional-already-met" accessibilityLiveRegion="polite" style={styles.warning}>
        선물 Last가 감시가격을 지났어요. 등록할 때 감시 방향을 다시 확인해요.
      </Text>
    ) : null}
    {directionNotice && directionNotice.triggerPrice === draft.triggerPrice ? (
      <Text testID="futures-conditional-direction-changed" accessibilityLiveRegion="polite" style={styles.warning}>
        {directionNotice.text}
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
    return '현재 선물 Last가 이미 감시가격을 지나 접수하지 않았습니다. 다시 정해진 감시 조건을 확인한 뒤 등록해주세요.';
  if (code === 'FUTURES_CONDITIONAL_ENTRY_PENDING')
    return '이 상품에는 이미 감시 중인 조건주문이 있습니다. 대기 주문에서 확인해주세요.';
  if (code === 'FUTURES_ENTRY_PENDING') return '대기 중인 지정가 진입 주문이 있어 등록할 수 없습니다.';
  if (code === 'FUTURES_POSITION_ALREADY_OPEN') return '보유 포지션이 있어 새 조건주문을 등록할 수 없습니다.';
  if (code === 'FUTURES_CONDITIONAL_ENTRY_LIMIT_EXCEEDED') return '감시 중인 조건주문이 많아 더 등록할 수 없습니다.';
  if (code === 'FUTURES_CONDITIONAL_ENTRY_DISABLED') return '현재 선물 조건주문을 등록할 수 없습니다.';
  if (code === 'FUTURES_PRICE_UNAVAILABLE' || code === 'FUTURES_PRICE_STALE')
    return '현재 선물 Last를 확인할 수 없어 접수하지 않았습니다. 잠시 후 다시 시도해주세요.';
  if (code === 'FUTURES_REDUCE_ONLY' || code === 'FUTURES_TRADING_DISABLED') return '현재 선물 신규 진입이 제한되어 있습니다.';
  if (code === 'BEGINNER_FEATURE_LOCKED') return getErrorMessageFromCode(code);
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
  warning: { color: semantic.warning, fontSize: 12, lineHeight: 18, flexShrink: 1 },
  direction: { color: semantic.info, fontSize: 13, lineHeight: 19, fontWeight: '600', flexShrink: 1 },
});
