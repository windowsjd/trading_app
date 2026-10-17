import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../../components/common/CTAButton';
import SegmentedControl from '../../components/common/SegmentedControl';
import ErrorNotice from '../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  createConditionalBuyOrder,
  type ConditionalBuyCapabilitiesDto,
  type ConditionalBuyCreateDto,
  type ConditionalBuyExecutionType,
  type ConditionalBuyOrderDto,
} from '../../features/conditional/conditionalBuyApi';
import {
  EXECUTION_TYPE_LABEL,
  TRIGGER_CONDITION_LABEL,
  getConditionalBuyDraftError,
  getConditionalBuyResultNotice,
} from '../../features/conditional/conditionalBuyDisplay';
import { getTriggerDirectionText, isTriggerDirectionValid } from '../../features/conditional/autoDirection';
import { useTriggerDirection } from '../../features/conditional/useTriggerDirection';
import { emitOrderFillEvent } from '../../features/order/fillEvents';
import { BUY_COLOR } from '../../features/order/sideColors';
import { getApiErrorCode, getApiErrorInfo, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatCurrency, formatDisplayDecimal } from '../../utils/format';
import OrderNumberInput, { orderInputStyle } from './OrderNumberInput';

type LearningGate = { allowed: boolean; locked: boolean; message: string | null; guard: (work: () => void) => void };

type Request = { accountId: string; epoch: number; body: ConditionalBuyCreateDto };

const UNCERTAIN_CREATE = '등록 결과를 확인하지 못했어요. 대기 목록의 조건주문을 먼저 확인해 주세요. 같은 내용으로 다시 누르면 중복 없이 다시 확인해요.';

/**
 * New Conditional BUY (KRX stocks, crypto Spot). The watch price and the
 * limit price are separate fields; 이상/이하 follows the watch price against
 * the current price (never chosen by hand); nothing is reserved while
 * watching, and a registration is never presented as a fill. The server
 * re-checks every rule.
 */
export default function ConditionalBuyForm({
  accountId,
  asset,
  capabilities,
  blockedReason,
  buyAvailable,
  currentPrice,
  marketClosed,
  learning,
  onInputFocus,
  onInputBlur,
}: {
  accountId: string;
  asset: { assetType?: string | null; settlementCurrency?: string | null; symbol?: string | null; id: string };
  capabilities: ConditionalBuyCapabilitiesDto | null;
  /** Account/asset gates the order form already resolved. */
  blockedReason: string | null;
  buyAvailable: string | null;
  /** The screen's fresh current price: the reference for 이상/이하. */
  currentPrice: string | null;
  marketClosed: boolean;
  learning: LearningGate;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
}) {
  const queryClient = useQueryClient();
  const crypto = asset.assetType === 'crypto';
  const currency = asset.settlementCurrency ?? '';
  const [triggerPrice, setTriggerPrice] = useState('');
  const [offHoursDirection, setOffHoursDirection] = useState<'at_or_above' | 'at_or_below' | null>(null);
  const trigger = useTriggerDirection(triggerPrice, currentPrice);
  const condition = marketClosed ? offHoursDirection : trigger.condition;
  const [directionNotice, setDirectionNotice] = useState<string | null>(null);
  const [executionType, setExecutionType] = useState<ConditionalBuyExecutionType>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [size, setSize] = useState('');
  const [registered, setRegistered] = useState<ConditionalBuyOrderDto | null>(null);
  // The original error only; its public copy is mapped where it is shown.
  const [error, setError] = useState<{ cause: unknown; uncertain: boolean } | null>(null);
  // An uncertain create keeps its exact key and body for a same-intent retry;
  // any edit makes a new intent with a new key.
  const actionRef = useRef<Request | null>(null);
  const scopeRef = useRef({ epoch: 0, mounted: true });
  useEffect(() => {
    // One scope object for the form's life; only its fields change.
    const scope = scopeRef.current;
    scope.mounted = true;
    return () => {
      scope.mounted = false;
    };
  }, []);
  const isCurrent = (request: Request) => scopeRef.current.mounted && request.epoch === scopeRef.current.epoch;

  const mutation = useMutation({
    mutationFn: (request: Request) => createConditionalBuyOrder(request.accountId, request.body),
    retry: false,
    onSuccess: async (result, request) => {
      // The watch is the server's record now, wherever the user went.
      emitOrderFillEvent({ kind: 'watch', accountId: request.accountId, watchId: result.conditionalOrder.id });
      if (isCurrent(request)) {
        actionRef.current = null;
        setRegistered(result.conditionalOrder);
        setError(null);
        setTriggerPrice('');
        setLimitPrice('');
        setSize('');
        setExecutionType('market');
      }
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.all(request.accountId) });
    },
    onError: (cause, request) => {
      if (!isCurrent(request)) return;
      const info = getApiErrorInfo(cause);
      const uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
      if (!uncertain) actionRef.current = null;
      // The server's own price had already crossed the watch price: decide
      // the direction again from the latest price before another try.
      if (info.serverCode === 'CONDITIONAL_BUY_ALREADY_MET') trigger.reset();
      setError({ cause, uncertain });
    },
  });
  const pending = mutation.isPending;

  const edit = (update: () => void) => {
    if (pending) return;
    update();
    actionRef.current = null;
    scopeRef.current.epoch += 1;
    setRegistered(null);
    setError(null);
    setDirectionNotice(null);
  };

  const canUseLimit = capabilities?.canUseLimit === true;
  // No usable current price, or a watch price equal to it: no direction yet.
  const directionError = marketClosed ? (!offHoursDirection ? '감시 방향을 선택해주세요.' : null)
    : trigger.direction.state === 'no_reference' || trigger.direction.state === 'equal'
      ? getTriggerDirectionText(trigger.direction, triggerPrice, currency) : null;
  // A limit choice that became unavailable falls back to nothing, not to market.
  const draftError = getConditionalBuyDraftError({
    assetType: asset.assetType, triggerPrice, executionType, limitPrice, size,
  }) ?? directionError ?? (executionType === 'limit' && !canUseLimit ? '지정가 발동은 현재 운영 상태에서 이용할 수 없어요.' : null);
  const directionText = marketClosed ? null : getTriggerDirectionText(trigger.direction, triggerPrice, currency);
  // The market moved past the watch price after the direction was decided.
  const crossed = !marketClosed && !!condition && !!currentPrice && !isTriggerDirectionValid(condition, triggerPrice, currentPrice);
  const createBlocked = !capabilities?.canCreate ? '현재 조건주문을 새로 등록할 수 없어요.' : null;
  const canSubmit = !blockedReason && !createBlocked && !draftError && !pending;
  const typed = !!(triggerPrice.trim() || size.trim() || limitPrice.trim());
  // A replayed create returns the watch as it is NOW (it may have triggered,
  // ordered, filled or ended since): the server's state decides the copy.
  const result = registered ? getConditionalBuyResultNotice(registered) : null;

  const submit = () => {
    if (!learning.allowed && !actionRef.current) {
      learning.guard(() => undefined);
      return;
    }
    if (!canSubmit || !condition) return;
    setError(null);
    // Never send a direction the latest price no longer supports.
    if (!actionRef.current) {
      const changed = marketClosed ? null : trigger.recheck(currentPrice);
      if (changed) { setDirectionNotice(changed); return; }
    }
    setDirectionNotice(null);
    actionRef.current ??= {
      accountId,
      epoch: scopeRef.current.epoch,
      body: {
        assetId: asset.id,
        triggerCondition: condition,
        triggerPrice: triggerPrice.trim(),
        executionType,
        ...(executionType === 'limit' ? { limitPrice: limitPrice.trim() } : {}),
        ...(crypto ? { amount: size.trim() } : { quantity: size.trim() }),
        idempotencyKey: createIdempotencyKey('conditional_buy'),
      },
    };
    mutation.mutate(actionRef.current);
  };

  return (
    <View style={styles.form} testID="conditional-buy-form">
      <View style={styles.group}>
        <Text style={styles.label}>감시가격 ({currency})</Text>
        <OrderNumberInput
          testID="conditional-trigger-price"
          accessibilityLabel={`감시가격 ${currency}`}
          editable={!pending}
          style={orderInputStyle}
          value={triggerPrice}
          onChangeText={(value) => edit(() => setTriggerPrice(value))}
          keyboardType="decimal-pad"
          placeholder="감시가격 입력"
          onFieldFocus={onInputFocus}
          onBlur={onInputBlur}
        />
        {marketClosed ? (
            <View style={styles.group}>
              <Text style={styles.helper}>정규장 외 등록 · 다음 정규장부터 감시합니다. 감시 방향을 선택해주세요.</Text>
              <SegmentedControl
                testID="conditional-offhours-direction"
                accessibilityLabel="감시 방향"
                compact
                value={offHoursDirection ?? ''}
                onChange={(value) => edit(() => setOffHoursDirection(value || null))}
                options={(['', 'at_or_above', 'at_or_below'] as const).map((value) => ({
                  key: value, label: value === '' ? '방향 선택' : TRIGGER_CONDITION_LABEL[value],
                  testID: `conditional-trigger-${value || 'choose'}`, disabled: pending,
                }))}
              />
            </View>
          ) : null}
        {directionText ? (
          <Text testID="conditional-trigger-direction" accessibilityLiveRegion="polite"
            style={trigger.direction.state === 'ready' ? styles.direction : styles.error}>
            {trigger.direction.state === 'ready' ? `감시 조건 · ${directionText}` : directionText}
          </Text>
        ) : null}
        {crossed ? (
          <Text testID="conditional-already-met" style={styles.warning}>
            현재가가 감시가격을 지났어요. 등록할 때 감시 방향을 다시 확인해요.
          </Text>
        ) : null}
      </View>
      <View style={styles.group}>
        <Text style={styles.label}>발동 시 주문방식</Text>
        <SegmentedControl
          testID="conditional-execution-type"
          accessibilityLabel="발동 시 주문방식"
          compact
          value={executionType}
          onChange={(next) => edit(() => {
            setExecutionType(next);
            if (next === 'market') setLimitPrice('');
          })}
          options={(['market', 'limit'] as const).map((value) => ({
            key: value,
            label: EXECUTION_TYPE_LABEL[value],
            testID: `conditional-execution-${value}`,
            disabled: pending || (value === 'limit' && !canUseLimit),
          }))}
        />
        {!canUseLimit ? <Text style={styles.helper}>지정가 발동은 현재 운영 상태에서 이용할 수 없어요.</Text> : null}
      </View>
      {executionType === 'limit' ? (
        <View style={styles.group}>
          <Text style={styles.label}>발동 시 지정가격 ({currency})</Text>
          <OrderNumberInput
            testID="conditional-limit-price"
            accessibilityLabel={`발동 시 지정가격 ${currency}`}
            editable={!pending}
            style={orderInputStyle}
            value={limitPrice}
            onChangeText={(value) => edit(() => setLimitPrice(value))}
            keyboardType="decimal-pad"
            placeholder="지정가격 입력"
            onFieldFocus={onInputFocus}
            onBlur={onInputBlur}
          />
        </View>
      ) : null}
      <View style={styles.group}>
        <Text style={styles.label}>{crypto ? `매수 금액 (${currency})` : '수량'}</Text>
        <OrderNumberInput
          testID="conditional-size"
          accessibilityLabel={crypto ? `매수 금액 ${currency}` : '주문 수량'}
          editable={!pending}
          style={orderInputStyle}
          value={size}
          onChangeText={(value) => edit(() => setSize(value))}
          keyboardType="decimal-pad"
          placeholder={crypto ? '매수 금액 입력' : '수량 입력'}
          onFieldFocus={onInputFocus}
          onBlur={onInputBlur}
        />
        {crypto ? <Text style={styles.helper}>수수료를 제외한 매수 원금이에요.</Text>
          : executionType === 'limit' ? <Text style={styles.helper}>지정가 발동은 정수 수량만 가능해요.</Text> : null}
      </View>
      <Text style={styles.helper}>
        현재 주문 가능 {buyAvailable !== null ? formatCurrency(buyAvailable, currency) : '-'} · 감시 중에는 금액을 예약하지 않아요
      </Text>
      {blockedReason || createBlocked ? (
        <Text testID="conditional-blocked" style={styles.error}>{blockedReason ?? createBlocked}</Text>
      ) : null}
      {typed && draftError && draftError !== directionError ? <Text testID="conditional-input-error" style={styles.error}>{draftError}</Text> : null}
      {directionNotice ? <Text testID="conditional-direction-changed" accessibilityLiveRegion="polite" style={styles.warning}>{directionNotice}</Text> : null}
      {error ? (
        <ErrorNotice error={error.cause} message={error.uncertain ? UNCERTAIN_CREATE : getErrorMessageFromCode(getApiErrorCode(error.cause))}
          testID="conditional-error" style={styles.error} />
      ) : null}
      {registered && result ? (
        <View testID="conditional-registered" accessibilityLiveRegion="polite" style={RESULT_SURFACE[result.tone]}>
          <Text testID="conditional-registered-title" style={[styles.resultTitle, RESULT_TITLE[result.tone]]}>{result.title}</Text>
          {result.detail ? <Text testID="conditional-registered-detail" style={styles.helper}>{result.detail}</Text> : null}
          <Text style={styles.helper}>
            감시가격 {formatDisplayDecimal(registered.triggerPrice)} {currency} {TRIGGER_CONDITION_LABEL[registered.triggerCondition]} 시
            {' '}{registered.executionType === 'limit' && registered.limitPrice ? `지정가 ${formatDisplayDecimal(registered.limitPrice)} ${currency}` : '시장가'} 매수
          </Text>
          <Text style={styles.helper}>{result.next}</Text>
        </View>
      ) : null}
      <CTAButton
        testID="conditional-submit"
        label={actionRef.current && error ? '같은 내용으로 다시 확인' : '조건주문 등록'}
        style={{ backgroundColor: BUY_COLOR }}
        state={pending ? 'loading' : canSubmit ? 'enabled' : 'disabled'}
        learningHint={learning.locked ? learning.message : null}
        onPress={submit}
      />
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  form: { gap: 12, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted },
  helper: { fontSize: 12, lineHeight: 17, color: semantic.secondary },
  warning: { fontSize: 12, lineHeight: 17, color: semantic.warning },
  error: { fontSize: 12, lineHeight: 17, color: semantic.error },
  direction: { fontSize: 13, lineHeight: 19, fontWeight: '600', color: semantic.info },
  resultTitle: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
} as const;

const resultSurface = { gap: 4, padding: 10, borderRadius: 10 } as const;
const RESULT_SURFACE = {
  success: { ...resultSurface, backgroundColor: semantic.successSurface },
  progress: { ...resultSurface, backgroundColor: semantic.infoSurface },
  ended: { ...resultSurface, backgroundColor: semantic.raised },
  error: { ...resultSurface, backgroundColor: semantic.errorSurface },
} as const;
const RESULT_TITLE = {
  success: { color: semantic.success },
  progress: { color: semantic.info },
  ended: { color: semantic.text },
  error: { color: semantic.error },
} as const;
