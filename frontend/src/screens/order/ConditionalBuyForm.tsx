import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import SegmentedControl from '../../components/common/SegmentedControl';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  createConditionalBuyOrder,
  type ConditionalBuyCapabilitiesDto,
  type ConditionalBuyCreateDto,
  type ConditionalBuyExecutionType,
  type ConditionalBuyOrderDto,
  type ConditionalBuyTriggerCondition,
} from '../../features/conditional/conditionalBuyApi';
import {
  EXECUTION_TYPE_LABEL,
  TRIGGER_CONDITION_LABEL,
  getConditionalBuyDraftError,
  isConditionAlreadyMet,
} from '../../features/conditional/conditionalBuyDisplay';
import { emitOrderFillEvent } from '../../features/order/fillEvents';
import { BUY_COLOR } from '../../features/order/sideColors';
import { getApiErrorCode, getApiErrorInfo, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatCurrency, formatDisplayDecimal } from '../../utils/format';
import OrderNumberInput, { orderInputStyle } from './OrderNumberInput';

type LearningGate = { allowed: boolean; locked: boolean; message: string | null; guard: (work: () => void) => void };

type Request = { accountId: string; epoch: number; body: ConditionalBuyCreateDto };

const CONDITIONS: ConditionalBuyTriggerCondition[] = ['at_or_above', 'at_or_below'];

/**
 * New Conditional BUY (KRX stocks, crypto Spot). The watch price and the
 * limit price are separate fields; nothing is reserved while watching, and a
 * registration is never presented as a fill. The server re-checks every rule.
 */
export default function ConditionalBuyForm({
  accountId,
  asset,
  capabilities,
  blockedReason,
  buyAvailable,
  currentPrice,
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
  /** The screen's current price, only for the "already met" hint. */
  currentPrice: string | null;
  learning: LearningGate;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
}) {
  const queryClient = useQueryClient();
  const crypto = asset.assetType === 'crypto';
  const currency = asset.settlementCurrency ?? '';
  const [condition, setCondition] = useState<ConditionalBuyTriggerCondition | null>(null);
  const [triggerPrice, setTriggerPrice] = useState('');
  const [executionType, setExecutionType] = useState<ConditionalBuyExecutionType>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [size, setSize] = useState('');
  const [registered, setRegistered] = useState<ConditionalBuyOrderDto | null>(null);
  const [error, setError] = useState<{ message: string; cause: unknown } | null>(null);
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
        setCondition(null);
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
      const code = getApiErrorCode(cause);
      const uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
      if (!uncertain) actionRef.current = null;
      setError({
        cause,
        message: uncertain
          ? '등록 결과를 확인하지 못했어요. 대기 목록의 조건주문을 먼저 확인해 주세요. 같은 내용으로 다시 누르면 중복 없이 다시 확인해요.'
          : getErrorMessageFromCode(code),
      });
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
  };

  const canUseLimit = capabilities?.canUseLimit === true;
  // A limit choice that became unavailable falls back to nothing, not to market.
  const draftError = getConditionalBuyDraftError({
    assetType: asset.assetType, triggerCondition: condition, triggerPrice, executionType, limitPrice, size,
  }) ?? (executionType === 'limit' && !canUseLimit ? '지정가 발동은 현재 운영 상태에서 이용할 수 없어요.' : null);
  const alreadyMet = isConditionAlreadyMet(condition, triggerPrice, currentPrice);
  const createBlocked = !capabilities?.canCreate ? '현재 조건주문을 새로 등록할 수 없어요.' : null;
  const canSubmit = !blockedReason && !createBlocked && !draftError && !pending;
  const typed = !!(triggerPrice.trim() || size.trim() || limitPrice.trim());

  const submit = () => {
    if (!learning.allowed && !actionRef.current) {
      learning.guard(() => undefined);
      return;
    }
    if (!canSubmit) return;
    setError(null);
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
        <Text style={styles.label}>감시 조건</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="감시 조건" style={styles.choices}>
          {CONDITIONS.map((value) => {
            const selected = condition === value;
            return (
              <ActionPressable
                key={value}
                testID={`conditional-trigger-${value}`}
                accessibilityRole="radio"
                accessibilityLabel={`감시가격 ${TRIGGER_CONDITION_LABEL[value]}`}
                accessibilityState={{ selected, checked: selected, disabled: pending }}
                aria-selected={selected}
                disabled={pending}
                onPress={() => edit(() => setCondition(value))}
                style={[styles.choice, selected && styles.choiceSelected]}
              >
                <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>감시가격 {TRIGGER_CONDITION_LABEL[value]}</Text>
              </ActionPressable>
            );
          })}
        </View>
      </View>
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
        {alreadyMet ? (
          <Text testID="conditional-already-met" style={styles.warning}>
            현재가가 이미 이 조건을 충족해 등록이 거부될 수 있어요.
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
          <Text style={styles.helper}>감시가격과 별개예요. 조건 충족 후 이 가격으로 지정가 매수가 접수돼요.</Text>
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
        <Text style={styles.helper}>
          {crypto
            ? '수수료를 제외한 매수 원금이에요. 실제 수량은 발동 시점 가격으로 서버가 정해요.'
            : executionType === 'limit' ? '지정가 발동은 정수 수량만 가능해요.' : '발동 시 이 수량으로 시장가 매수를 시도해요.'}
        </Text>
      </View>
      <Text style={styles.helper}>
        현재 주문 가능 {buyAvailable !== null ? formatCurrency(buyAvailable, currency) : '-'} · 감시 중에는 금액을 예약하지 않아요
      </Text>
      <View style={styles.policy} testID="conditional-policy">
        {[
          '감시가격에 도달하면 설정한 방식으로 일반 매수 주문을 한 번 만들어요. 조건 충족은 체결이 아니에요.',
          '시장가 발동은 그때의 시장가로 실행되고, 지정가 발동은 지정가 주문으로 접수된 뒤 기존 자동 체결 정책을 따라요.',
          '감시 중에는 현금을 예약하지 않아요. 발동 시점의 잔액 부족·시세 부족·장 상태 때문에 실패할 수 있어요.',
          '조건 충족 후 30초 안에 주문을 만들지 못하면 실패로 끝나요.',
          crypto ? '암호화폐는 Binance 현물 가격으로만 감시해요.' : '한국주식은 정규장 시간의 신선한 시세로만 감시해요. 등록도 정규장 중에 할 수 있어요.',
          '등록할 때 이미 조건을 충족한 가격이면 등록되지 않아요.',
          capabilities ? `계정당 감시 중인 조건주문은 최대 ${capabilities.maxLivePerAccount}개예요.` : null,
        ].filter((line): line is string => !!line).map((line) => (
          <Text key={line} style={styles.policyLine}>· {line}</Text>
        ))}
      </View>
      {blockedReason || createBlocked ? (
        <Text testID="conditional-blocked" style={styles.error}>{blockedReason ?? createBlocked}</Text>
      ) : null}
      {typed && draftError ? <Text testID="conditional-input-error" style={styles.error}>{draftError}</Text> : null}
      {error ? (
        <>
          <Text testID="conditional-error" accessibilityLiveRegion="polite" style={styles.error}>{error.message}</Text>
          <AdminDiagnosticPanel error={error.cause} />
        </>
      ) : null}
      {registered ? (
        <View testID="conditional-registered" accessibilityLiveRegion="polite" style={styles.success}>
          <Text style={styles.successTitle}>조건주문이 등록되었습니다. 감시 중입니다.</Text>
          <Text style={styles.helper}>
            감시가격 {formatDisplayDecimal(registered.triggerPrice)} {currency} {TRIGGER_CONDITION_LABEL[registered.triggerCondition]} 시
            {' '}{registered.executionType === 'limit' && registered.limitPrice ? `지정가 ${formatDisplayDecimal(registered.limitPrice)} ${currency}` : '시장가'} 매수
          </Text>
          <Text style={styles.helper}>아래 대기 목록의 조건주문에서 상태를 확인하고 취소할 수 있어요.</Text>
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
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  choice: {
    flexGrow: 1,
    flexBasis: 120,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceSelected: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  choiceText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: semantic.text, textAlign: 'center' },
  choiceTextSelected: { color: semantic.onAccent },
  policy: { gap: 4, padding: 10, borderRadius: 10, backgroundColor: semantic.raised },
  policyLine: { fontSize: 12, lineHeight: 17, color: semantic.secondary },
  success: { gap: 4, padding: 10, borderRadius: 10, backgroundColor: semantic.successSurface },
  successTitle: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.success },
} as const;
