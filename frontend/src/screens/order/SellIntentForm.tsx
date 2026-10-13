import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import SegmentedControl from '../../components/common/SegmentedControl';
import ErrorNotice from '../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  createConditionalSellOrder,
  type ConditionalSellCapabilitiesDto,
  type ConditionalSellCreateDto,
  type ConditionalSellExecutionType,
  type ConditionalSellLegDto,
  type ConditionalSellOrderDto,
  type ConditionalSellTriggerCondition,
} from '../../features/conditional/conditionalSellApi';
import {
  SELL_EXECUTION_TYPE_LABEL,
  SELL_TRIGGER_CONDITION_LABEL,
  getConditionalSellKindLabel,
  getConditionalSellResultNotice,
  getSellLegDraftError,
  isSellConditionAlreadyMet,
  type SellLegDraft,
} from '../../features/conditional/conditionalSellDisplay';
import { emitOrderFillEvent } from '../../features/order/fillEvents';
import { SELL_COLOR } from '../../features/order/sideColors';
import { getApiErrorCode, getApiErrorInfo, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatDisplayDecimal } from '../../utils/format';
import OrderNumberInput, { orderInputStyle } from './OrderNumberInput';

type LearningGate = { allowed: boolean; locked: boolean; message: string | null; guard: (work: () => void) => void };
type LegKey = 'main' | 'stopLoss' | 'takeProfit';
type LegState = SellLegDraft & { enabled: boolean };
type Request = { accountId: string; epoch: number; body: ConditionalSellCreateDto };

const CONDITIONS: ConditionalSellTriggerCondition[] = ['at_or_above', 'at_or_below'];
const EMPTY_LEG: LegState = { enabled: false, triggerPrice: '', executionType: 'market', limitPrice: '', quantity: '' };
const LEG_LABEL: Record<LegKey, string> = { main: '', stopLoss: '손절', takeProfit: '익절' };
const LEG_TEST_ID: Record<LegKey, string> = { main: 'sell-condition', stopLoss: 'sell-stop-loss', takeProfit: 'sell-take-profit' };

const UNCERTAIN_CREATE = '등록 결과를 확인하지 못했어요. 대기 목록의 매도 설정을 먼저 확인해 주세요. 같은 내용으로 다시 누르면 중복 없이 다시 확인해요.';

/**
 * New SELL intents on an open KRX/crypto Spot holding: one user condition
 * (`mode="condition"`), or an independent stop-loss and/or take-profit with
 * their own quantities (`mode="protection"`, not OCO). Nothing is reserved
 * while watching; several settings may target more than the holding, and a
 * firing one sells at most the unreserved remainder at that moment. The form
 * only explains that — the server sizes and validates everything.
 */
export default function SellIntentForm({
  mode,
  accountId,
  asset,
  capabilities,
  blockedReason,
  holding,
  available,
  reserved,
  currentPrice,
  learning,
  onInputFocus,
  onInputBlur,
}: {
  mode: 'condition' | 'protection';
  accountId: string;
  asset: { assetType?: string | null; settlementCurrency?: string | null; symbol?: string | null; id: string };
  capabilities: ConditionalSellCapabilitiesDto | null;
  /** Account/asset/holding gates the order form already resolved. */
  blockedReason: string | null;
  /** The server's holding quantity; null while unknown. */
  holding: string | null;
  /** Holding minus other orders' reservations; null when the server did not say. */
  available: string | null;
  reserved: string | null;
  /** The screen's current price, only for "already met" hints. */
  currentPrice: string | null;
  learning: LearningGate;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
}) {
  const queryClient = useQueryClient();
  const currency = asset.settlementCurrency ?? '';
  const stock = asset.assetType === 'domestic_stock' || asset.assetType === 'us_stock';
  const family = mode === 'condition' ? capabilities?.condition : capabilities?.protection;
  const canUseLimit = family?.canUseLimit === true;
  const [condition, setCondition] = useState<ConditionalSellTriggerCondition | null>(null);
  const [legs, setLegs] = useState<Record<LegKey, LegState>>({
    main: { ...EMPTY_LEG, enabled: true },
    stopLoss: EMPTY_LEG,
    takeProfit: EMPTY_LEG,
  });
  const [registered, setRegistered] = useState<ConditionalSellOrderDto[] | null>(null);
  // The original error only; its public copy is mapped where it is shown.
  const [error, setError] = useState<{ cause: unknown; uncertain: boolean } | null>(null);
  // An uncertain create keeps its exact key and body for a same-intent retry;
  // any edit makes a new intent with a new key.
  const actionRef = useRef<Request | null>(null);
  const scopeRef = useRef({ epoch: 0, mounted: true });
  useEffect(() => {
    const scope = scopeRef.current;
    scope.mounted = true;
    return () => {
      scope.mounted = false;
    };
  }, []);
  const isCurrent = (request: Request) => scopeRef.current.mounted && request.epoch === scopeRef.current.epoch;

  const mutation = useMutation({
    mutationFn: (request: Request) => createConditionalSellOrder(request.accountId, request.body),
    retry: false,
    onSuccess: async (result, request) => {
      // The intents are the server's record now, wherever the user went.
      for (const row of result.conditionalOrders)
        emitOrderFillEvent({ kind: 'watch', side: 'sell', accountId: request.accountId, watchId: row.id });
      if (isCurrent(request)) {
        actionRef.current = null;
        setRegistered(result.conditionalOrders);
        setError(null);
        setCondition(null);
        setLegs({ main: { ...EMPTY_LEG, enabled: true }, stopLoss: EMPTY_LEG, takeProfit: EMPTY_LEG });
      }
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.all(request.accountId) });
    },
    onError: (cause, request) => {
      if (!isCurrent(request)) return;
      const info = getApiErrorInfo(cause);
      const uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
      if (!uncertain) actionRef.current = null;
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
  };
  const patchLeg = (key: LegKey, patch: Partial<LegState>) =>
    edit(() => setLegs((previous) => ({ ...previous, [key]: { ...previous[key], ...patch } })));

  const activeLegs: LegKey[] = mode === 'condition'
    ? ['main']
    : (['stopLoss', 'takeProfit'] as const).filter((key) => legs[key].enabled);
  const legError = (key: LegKey) =>
    getSellLegDraftError(legs[key], { assetType: asset.assetType, holding, label: LEG_LABEL[key] || undefined })
    ?? (legs[key].executionType === 'limit' && !canUseLimit ? '지정가 발동은 현재 운영 상태에서 이용할 수 없어요.' : null);
  const draftError = mode === 'condition'
    ? (!condition ? '감시 조건을 선택해주세요.' : legError('main'))
    : activeLegs.length === 0 ? '손절 또는 익절 중 하나 이상을 설정해주세요.'
    : activeLegs.map(legError).find((message) => message !== null) ?? null;
  // Hints only: registration is judged by the server's own fresh evidence.
  const alreadyMet = mode === 'condition'
    ? isSellConditionAlreadyMet(condition, legs.main.triggerPrice, currentPrice)
    : (legs.stopLoss.enabled && isSellConditionAlreadyMet('at_or_below', legs.stopLoss.triggerPrice, currentPrice))
      || (legs.takeProfit.enabled && isSellConditionAlreadyMet('at_or_above', legs.takeProfit.triggerPrice, currentPrice));
  const createBlocked = !family?.canCreate
    ? mode === 'condition' ? '현재 조건주문 매도를 새로 등록할 수 없어요.' : '현재 손절·익절을 새로 등록할 수 없어요.'
    : null;
  const canSubmit = !blockedReason && !createBlocked && !draftError && !pending;
  const typed = activeLegs.some((key) => !!(legs[key].triggerPrice.trim() || legs[key].quantity.trim() || legs[key].limitPrice.trim()));
  const result = registered ? getConditionalSellResultNotice(registered) : null;

  const legBody = (leg: LegState): ConditionalSellLegDto => ({
    triggerPrice: leg.triggerPrice.trim(),
    executionType: leg.executionType,
    ...(leg.executionType === 'limit' ? { limitPrice: leg.limitPrice.trim() } : {}),
    quantity: leg.quantity.trim(),
  });
  const submit = () => {
    if (!learning.allowed && !actionRef.current) {
      learning.guard(() => undefined);
      return;
    }
    if (!canSubmit || (mode === 'condition' && !condition)) return;
    setError(null);
    actionRef.current ??= {
      accountId,
      epoch: scopeRef.current.epoch,
      body: mode === 'condition' && condition
        ? { kind: 'condition', assetId: asset.id, triggerCondition: condition, ...legBody(legs.main),
            idempotencyKey: createIdempotencyKey('conditional_sell') }
        : { kind: 'protection', assetId: asset.id,
            ...(legs.stopLoss.enabled ? { stopLoss: legBody(legs.stopLoss) } : {}),
            ...(legs.takeProfit.enabled ? { takeProfit: legBody(legs.takeProfit) } : {}),
            idempotencyKey: createIdempotencyKey('sell_protection') },
    };
    mutation.mutate(actionRef.current);
  };
  /** 전량: the whole holding (cut to whole shares for a stock limit). */
  const fillAll = (key: LegKey) => {
    if (holding === null || Number(holding) <= 0) return;
    const whole = stock && legs[key].executionType === 'limit';
    patchLeg(key, { quantity: whole ? String(Math.floor(Number(holding))) : trimDecimal(holding) });
  };

  const fields = (key: LegKey) => {
    const leg = legs[key];
    const id = LEG_TEST_ID[key];
    const label = LEG_LABEL[key];
    const over = available !== null && Number(leg.quantity) > 0 && Number(leg.quantity) > Number(available)
      && (holding === null || Number(leg.quantity) <= Number(holding));
    return (
      <View style={styles.legFields}>
        <View style={styles.group}>
          <Text style={styles.label}>{label ? `${label} 감시가격` : '감시가격'} ({currency})</Text>
          <OrderNumberInput
            testID={`${id}-trigger-price`}
            accessibilityLabel={`${label ? `${label} ` : ''}감시가격 ${currency}`}
            editable={!pending}
            style={orderInputStyle}
            value={leg.triggerPrice}
            onChangeText={(value) => patchLeg(key, { triggerPrice: value })}
            keyboardType="decimal-pad"
            placeholder={key === 'stopLoss' ? '현재가보다 낮은 가격' : key === 'takeProfit' ? '현재가보다 높은 가격' : '감시가격 입력'}
            onFieldFocus={onInputFocus}
            onBlur={onInputBlur}
          />
        </View>
        <View style={styles.group}>
          <Text style={styles.label}>발동 시 주문방식</Text>
          <SegmentedControl
            testID={`${id}-execution`}
            accessibilityLabel={`${label ? `${label} ` : ''}발동 시 주문방식`}
            compact
            value={leg.executionType}
            onChange={(next: ConditionalSellExecutionType) => patchLeg(key, { executionType: next, ...(next === 'market' ? { limitPrice: '' } : {}) })}
            options={(['market', 'limit'] as const).map((value) => ({
              key: value,
              label: SELL_EXECUTION_TYPE_LABEL[value],
              testID: `${id}-execution-${value}`,
              disabled: pending || (value === 'limit' && !canUseLimit),
            }))}
          />
        </View>
        {leg.executionType === 'limit' ? (
          <View style={styles.group}>
            <Text style={styles.label}>발동 시 지정가격 ({currency})</Text>
            <OrderNumberInput
              testID={`${id}-limit-price`}
              accessibilityLabel={`${label ? `${label} ` : ''}발동 시 지정가격 ${currency}`}
              editable={!pending}
              style={orderInputStyle}
              value={leg.limitPrice}
              onChangeText={(value) => patchLeg(key, { limitPrice: value })}
              keyboardType="decimal-pad"
              placeholder="지정가격 입력"
              onFieldFocus={onInputFocus}
              onBlur={onInputBlur}
            />
            <Text style={styles.helper}>감시가격과 별개예요. 조건 충족 후 이 가격으로 지정가 매도가 접수돼요.</Text>
          </View>
        ) : null}
        <View style={styles.group}>
          <View style={styles.quantityHeader}>
            <Text style={styles.label}>{label ? `${label} 수량` : '매도 수량'}</Text>
            <ActionPressable
              testID={`${id}-all`}
              accessibilityRole="button"
              accessibilityLabel={`${label ? `${label} ` : ''}수량을 보유 수량 전체로 입력`}
              accessibilityState={{ disabled: pending || holding === null }}
              disabled={pending || holding === null}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              onPress={() => fillAll(key)}
              style={styles.chip}
            >
              <Text style={styles.chipText}>보유 전량</Text>
            </ActionPressable>
          </View>
          <OrderNumberInput
            testID={`${id}-quantity`}
            accessibilityLabel={`${label ? `${label} ` : ''}매도 수량`}
            editable={!pending}
            style={orderInputStyle}
            value={leg.quantity}
            onChangeText={(value) => patchLeg(key, { quantity: value })}
            keyboardType="decimal-pad"
            placeholder="수량 입력"
            onFieldFocus={onInputFocus}
            onBlur={onInputBlur}
          />
          {over ? (
            <Text testID={`${id}-quantity-notice`} style={styles.warning}>
              지금 발동하면 매도 가능 수량({formatDisplayDecimal(available)})만 매도돼요. 다른 주문이 예약한 수량은 쓰지 않아요.
            </Text>
          ) : null}
        </View>
      </View>
    );
  };

  const toggle = (key: 'stopLoss' | 'takeProfit') => {
    const enabled = legs[key].enabled;
    const title = key === 'stopLoss' ? '손절 설정' : '익절 설정';
    return (
      <ActionPressable
        testID={`${LEG_TEST_ID[key]}-toggle`}
        accessibilityRole="checkbox"
        accessibilityLabel={`${title}${key === 'stopLoss' ? ', 감시가격 이하로 내려가면 매도' : ', 감시가격 이상으로 오르면 매도'}`}
        accessibilityState={{ checked: enabled, disabled: pending }}
        aria-checked={enabled}
        disabled={pending}
        onPress={() => patchLeg(key, enabled ? { ...EMPTY_LEG } : { enabled: true })}
        style={[styles.toggle, enabled && styles.toggleOn]}
      >
        <View style={[styles.toggleBox, enabled && styles.toggleBoxOn]}>
          <Text style={styles.toggleMark}>{enabled ? '✓' : ''}</Text>
        </View>
        <View style={styles.toggleCopy}>
          <Text style={styles.toggleTitle}>{title}</Text>
          <Text style={styles.helper}>
            {key === 'stopLoss' ? '감시가격 이하로 내려가면 정한 수량을 매도해요.' : '감시가격 이상으로 오르면 정한 수량을 매도해요.'}
          </Text>
        </View>
      </ActionPressable>
    );
  };

  return (
    <View style={styles.form} testID={mode === 'condition' ? 'sell-condition-form' : 'sell-protection-form'}>
      {mode === 'condition' ? (
        <>
          <View style={styles.group}>
            <Text style={styles.label}>감시 조건</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="감시 조건" style={styles.choices}>
              {CONDITIONS.map((value) => {
                const selected = condition === value;
                return (
                  <ActionPressable
                    key={value}
                    testID={`sell-trigger-${value}`}
                    accessibilityRole="radio"
                    accessibilityLabel={`감시가격 ${SELL_TRIGGER_CONDITION_LABEL[value]} 시 매도`}
                    accessibilityState={{ selected, checked: selected, disabled: pending }}
                    aria-selected={selected}
                    disabled={pending}
                    onPress={() => edit(() => setCondition(value))}
                    style={[styles.choice, selected && styles.choiceSelected]}
                  >
                    <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
                      감시가격 {SELL_TRIGGER_CONDITION_LABEL[value]}
                    </Text>
                  </ActionPressable>
                );
              })}
            </View>
          </View>
          {fields('main')}
        </>
      ) : (
        <>
          <View style={styles.legSection}>
            {toggle('stopLoss')}
            {legs.stopLoss.enabled ? fields('stopLoss') : null}
          </View>
          <View style={styles.legSection}>
            {toggle('takeProfit')}
            {legs.takeProfit.enabled ? fields('takeProfit') : null}
          </View>
        </>
      )}
      {alreadyMet ? (
        <Text testID="sell-intent-already-met" style={styles.warning}>
          현재가가 이미 이 조건을 충족해 등록이 거부될 수 있어요.
        </Text>
      ) : null}
      <Text testID="sell-intent-holding" style={styles.helper}>
        보유 {holding !== null ? formatDisplayDecimal(holding) : '-'}
        {available !== null ? ` · 매도 가능 ${formatDisplayDecimal(available)}` : ''}
        {reserved !== null && Number(reserved) > 0 ? ` (다른 주문 예약 ${formatDisplayDecimal(reserved)})` : ''}
        {' · 감시 중에는 수량을 예약하지 않아요'}
      </Text>
      <View style={styles.policy} testID="sell-intent-policy">
        {[
          mode === 'condition'
            ? '감시가격에 도달하면 일반 매도 주문을 한 번 만들어요. 조건 충족은 체결이 아니에요.'
            : '손절과 익절은 서로 독립된 설정이에요. 한쪽이 실행돼도 다른 쪽은 취소되지 않고 남은 보유 수량 안에서만 매도해요.',
          '같은 종목에 여러 매도 설정을 둘 수 있고, 설정 수량의 합이 보유 수량보다 많아도 돼요.',
          '실제 매도 수량은 발동 시점의 매도 가능 수량(보유 − 다른 주문 예약)을 넘지 않아요. 남은 수량이 없으면 매도하지 않고 끝나요.',
          '보유 수량을 모두 팔면 남은 매도 설정은 함께 끝나요. 다시 사도 이전 설정은 이어지지 않아요.',
          '시장가 발동은 그때의 시장가로 실행되고, 지정가 발동은 지정가 매도로 접수된 뒤 기존 자동 체결 정책을 따라요.',
          '조건 충족 후 30초 안에 주문을 만들지 못하면 실패로 끝나요.',
          asset.assetType === 'crypto' ? '암호화폐는 Binance 현물 가격으로만 감시해요.' : '한국주식은 정규장 시간의 신선한 시세로만 감시해요. 등록도 정규장 중에 할 수 있어요.',
          '등록할 때 이미 조건을 충족한 가격이면 등록되지 않아요.',
          mode === 'protection' ? '보유종목 카드의 TP/SL(OCO) 보호가 있는 종목에는 함께 설정할 수 없어요.' : null,
          capabilities ? `계정당 감시 중인 매도 설정은 최대 ${capabilities.maxLivePerAccount}개예요.` : null,
        ].filter((line): line is string => !!line).map((line) => (
          <Text key={line} style={styles.policyLine}>· {line}</Text>
        ))}
      </View>
      {blockedReason || createBlocked ? (
        <Text testID="sell-intent-blocked" style={styles.error}>{blockedReason ?? createBlocked}</Text>
      ) : null}
      {(typed || mode === 'protection') && draftError ? (
        <Text testID="sell-intent-input-error" style={styles.error}>{draftError}</Text>
      ) : null}
      {error ? (
        <ErrorNotice error={error.cause} message={error.uncertain ? UNCERTAIN_CREATE : getErrorMessageFromCode(getApiErrorCode(error.cause))}
          testID="sell-intent-error" style={styles.error} />
      ) : null}
      {registered && result ? (
        <View testID="sell-intent-registered" accessibilityLiveRegion="polite" style={RESULT_SURFACE[result.tone]}>
          <Text testID="sell-intent-registered-title" style={[styles.resultTitle, RESULT_TITLE[result.tone]]}>{result.title}</Text>
          {result.detail ? <Text style={styles.helper}>{result.detail}</Text> : null}
          {registered.map((row) => (
            <Text key={row.id} style={styles.helper}>
              {getConditionalSellKindLabel(row.kind)} · 감시가격 {formatDisplayDecimal(row.triggerPrice)} {currency}{' '}
              {SELL_TRIGGER_CONDITION_LABEL[row.triggerCondition] ?? ''} 시{' '}
              {row.executionType === 'limit' && row.limitPrice ? `지정가 ${formatDisplayDecimal(row.limitPrice)} ${currency}` : '시장가'}
              {' '}매도 · 설정 수량 {formatDisplayDecimal(row.quantity)}
            </Text>
          ))}
          <Text style={styles.helper}>{result.next}</Text>
        </View>
      ) : null}
      <CTAButton
        testID="sell-intent-submit"
        label={actionRef.current && error ? '같은 내용으로 다시 확인' : mode === 'condition' ? '조건주문 매도 등록' : '손절·익절 등록'}
        style={{ backgroundColor: SELL_COLOR }}
        state={pending ? 'loading' : canSubmit ? 'enabled' : 'disabled'}
        learningHint={learning.locked ? learning.message : null}
        onPress={submit}
      />
    </View>
  );
}

function trimDecimal(value: string) {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/u, '').replace(/\.$/u, '');
  // Inputs accept at most 6 decimals; never round a holding up.
  const [whole, fraction = ''] = trimmed.split('.');
  return fraction ? `${whole}.${fraction.slice(0, 6)}` : whole;
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  form: { gap: 12, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  legFields: { gap: 10, minWidth: 0 },
  legSection: { gap: 10, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted, flexShrink: 1 },
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
  quantityHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4 },
  chip: {
    minHeight: 32,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: semantic.text },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
  },
  toggleOn: { borderColor: semantic.selected },
  // Grows with the font scale instead of clipping the check mark.
  toggleBox: {
    minWidth: 22,
    minHeight: 22,
    paddingHorizontal: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: semantic.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  toggleBoxOn: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  toggleMark: { fontSize: 14, fontWeight: '800', color: semantic.onAccent, textAlign: 'center' },
  toggleCopy: { flex: 1, minWidth: 0, gap: 2 },
  toggleTitle: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.text },
  policy: { gap: 4, padding: 10, borderRadius: 10, backgroundColor: semantic.raised },
  policyLine: { fontSize: 12, lineHeight: 17, color: semantic.secondary },
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
