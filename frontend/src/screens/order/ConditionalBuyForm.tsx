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
import {
  getTriggerDirectionText,
  isTriggerDirectionValid,
  type TriggerCondition,
} from '../../features/conditional/autoDirection';
import {
  DIRECTION_REQUIRED,
  LIVE_PRICE_UNAVAILABLE,
  OFF_SESSION_REGISTRATION_NOTICE,
  getConditionalRegistrationErrorMessage,
  resolveConditionalDirectionMode,
  shouldRefreshAfterRegistrationError,
} from '../../features/conditional/directionMode';
import {
  conditionalBuySizeAtRatio,
  getConditionalBuyRatioBlock,
  ratioOfCapacity,
} from '../../features/conditional/conditionalRatio';
import { useTriggerDirection } from '../../features/conditional/useTriggerDirection';
import { emitOrderFillEvent } from '../../features/order/fillEvents';
import { BUY_COLOR } from '../../features/order/sideColors';
import { getApiErrorCode, getApiErrorInfo, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatCurrency, formatDisplayDecimal } from '../../utils/format';
import ActionPressable from '../../components/common/ActionPressable';
import OrderNumberInput, { orderInputStyle } from './OrderNumberInput';
import OrderRatioControls from './OrderRatioControls';
import TriggerDirectionChoice from './TriggerDirectionChoice';

type LearningGate = { allowed: boolean; locked: boolean; message: string | null; guard: (work: () => void) => void };

type Request = { accountId: string; epoch: number; body: ConditionalBuyCreateDto };

const UNCERTAIN_CREATE = '등록 결과를 확인하지 못했어요. 대기 목록의 조건주문을 먼저 확인해 주세요. 같은 내용으로 다시 누르면 중복 없이 다시 확인해요.';

/**
 * New Conditional BUY (KRX/US stocks, crypto Spot). The watch price and the
 * limit price are separate fields. During the session (and always for
 * crypto) 이상/이하 follows the watch price against the fresh current price;
 * while a stock market is closed the user chooses it and the server watches
 * from the next regular session (2026-10-18); an unknown market state
 * registers nothing. The size can be typed or picked as a share of the
 * available cash (ratio controls). Nothing is reserved while watching, and a
 * registration is never presented as a fill. The server re-checks every rule.
 */
export default function ConditionalBuyForm({
  accountId,
  asset,
  capabilities,
  blockedReason,
  buyAvailable,
  feeRate = null,
  currentPrice,
  marketStatus = null,
  learning,
  onInputFocus,
  onInputBlur,
  onRefreshPrice,
}: {
  accountId: string;
  asset: { assetType?: string | null; settlementCurrency?: string | null; symbol?: string | null; id: string };
  capabilities: ConditionalBuyCapabilitiesDto | null;
  /** Account/asset gates the order form already resolved. */
  blockedReason: string | null;
  buyAvailable: string | null;
  /** The account's trade fee rate (ratio fee headroom); null while unknown. */
  feeRate?: string | null;
  /** The screen's fresh current price: the reference for 이상/이하. */
  currentPrice: string | null;
  /** The screen's market state: automatic or chosen 이상/이하. */
  marketStatus?: string | null;
  learning: LearningGate;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
  /** Reads the screen's price and market state again. */
  onRefreshPrice?: () => void;
}) {
  const queryClient = useQueryClient();
  const crypto = asset.assetType === 'crypto';
  const currency = asset.settlementCurrency ?? '';
  const directionMode = resolveConditionalDirectionMode({
    assetType: asset.assetType, marketStatus, offSessionMarkets: capabilities?.offSessionMarkets,
  });
  const manual = directionMode.mode === 'manual';
  const [triggerPrice, setTriggerPrice] = useState('');
  // Automatic only in session: a closed market's last price is no reference.
  const trigger = useTriggerDirection(triggerPrice, manual ? null : currentPrice);
  const [chosenCondition, setChosenCondition] = useState<TriggerCondition | null>(null);
  // Every closed period starts without a choice; nothing is ever assumed.
  useEffect(() => {
    if (!manual) setChosenCondition(null);
  }, [manual]);
  const condition = directionMode.mode === 'auto' ? trigger.condition : manual ? chosenCondition : null;
  const [directionNotice, setDirectionNotice] = useState<string | null>(null);
  const [executionType, setExecutionType] = useState<ConditionalBuyExecutionType>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [size, setSize] = useState('');
  // The pick that produced `size` (kept only while it still does).
  const [chosenRatio, setChosenRatio] = useState<number | null>(null);
  const [ratioNotice, setRatioNotice] = useState<string | null>(null);
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
        setChosenRatio(null);
        setChosenCondition(null);
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
      // The server saw another price or session than this screen: read both again.
      if (shouldRefreshAfterRegistrationError(info.serverCode)) onRefreshPrice?.();
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
    setRatioNotice(null);
  };

  const canUseLimit = capabilities?.canUseLimit === true;
  // Automatic: no usable current price (a price failure, never a closure) or a
  // watch price equal to it. Chosen: nothing chosen yet. Blocked: the cause.
  const directionError = directionMode.mode === 'blocked' ? directionMode.reason
    : manual ? chosenCondition ? null : DIRECTION_REQUIRED
      : trigger.direction.state === 'no_reference' ? LIVE_PRICE_UNAVAILABLE
        : trigger.direction.state === 'equal' ? getTriggerDirectionText(trigger.direction, triggerPrice, currency) : null;
  // A limit choice that became unavailable falls back to nothing, not to market.
  const draftError = getConditionalBuyDraftError({
    assetType: asset.assetType, triggerPrice, executionType, limitPrice, size,
  }) ?? directionError ?? (executionType === 'limit' && !canUseLimit ? '지정가 발동은 현재 운영 상태에서 이용할 수 없어요.' : null);
  // A chosen direction reads like an automatic one once a valid price is typed.
  const triggerEntered = trigger.direction.state !== 'empty' && trigger.direction.state !== 'invalid';
  const directionText = getTriggerDirectionText(manual && chosenCondition && triggerEntered
    ? { state: 'ready', condition: chosenCondition } : trigger.direction, triggerPrice, currency);
  // The market moved past the watch price after the direction was decided.
  const crossed = !manual && !!condition && !!currentPrice && !isTriggerDirectionValid(condition, triggerPrice, currentPrice);
  const createBlocked = !capabilities?.canCreate ? '현재 조건주문을 새로 등록할 수 없어요.' : null;
  const canSubmit = !blockedReason && !createBlocked && !draftError && !pending;
  const typed = !!(triggerPrice.trim() || size.trim() || limitPrice.trim());
  // Ratio picks: a share of the available cash (the server re-checks it when
  // the watch fires). Without a safe price the size is typed instead.
  const ratioInput = {
    crypto, executionType, available: buyAvailable, feeRate, currentPrice: manual ? null : currentPrice,
    triggerPrice, limitPrice, offSession: manual, currency,
  };
  const ratioBlock = getConditionalBuyRatioBlock(ratioInput);
  const ratioDisabled = pending || !!blockedReason || !!createBlocked || !!ratioBlock;
  const sizeAtRatio = (ratio: number) => (ratioBlock ? null : conditionalBuySizeAtRatio(ratioInput, ratio));
  const activeRatio = !ratioBlock && chosenRatio !== null
    && (chosenRatio === 0 ? size === '' : sizeAtRatio(chosenRatio) === size) ? chosenRatio : null;
  const shownRatio = activeRatio ?? (ratioBlock ? 0 : ratioOfCapacity(size, sizeAtRatio(1)));
  const applyRatio = (value: number) => {
    if (ratioDisabled || !Number.isFinite(value)) return;
    const ratio = Math.max(0, Math.min(1, value));
    const next = ratio === 0 ? '' : sizeAtRatio(ratio);
    if (next === null) {
      setRatioNotice(crypto ? '계산된 매수 금액이 너무 작아요.' : '계산된 수량이 너무 작아요.');
      return;
    }
    edit(() => setSize(next));
    setChosenRatio(ratio);
  };
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
    // Never send an automatic direction the latest price no longer supports;
    // a chosen one (market closed) is sent as chosen.
    if (!actionRef.current && directionMode.mode === 'auto') {
      const changed = trigger.recheck(currentPrice);
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
        {manual ? (
          <>
            <Text testID="conditional-off-session-notice" style={styles.notice}>{OFF_SESSION_REGISTRATION_NOTICE}</Text>
            <TriggerDirectionChoice
              testID="conditional-trigger"
              value={chosenCondition}
              disabled={pending}
              onChange={(next) => edit(() => setChosenCondition(next))}
            />
            {chosenCondition && triggerEntered && directionText ? (
              <Text testID="conditional-trigger-direction" accessibilityLiveRegion="polite" style={styles.direction}>
                {`감시 조건 · ${directionText}`}
              </Text>
            ) : null}
          </>
        ) : directionMode.mode === 'blocked' ? (
          <Text testID="conditional-trigger-direction" accessibilityLiveRegion="polite" style={styles.error}>
            {directionMode.reason}
          </Text>
        ) : trigger.direction.state === 'no_reference' ? (
          <>
            <Text testID="conditional-trigger-direction" accessibilityLiveRegion="polite" style={styles.error}>
              {LIVE_PRICE_UNAVAILABLE}
            </Text>
            {onRefreshPrice ? (
              <ActionPressable
                testID="conditional-price-refresh"
                accessibilityRole="button"
                accessibilityLabel="시세 다시 불러오기"
                disabled={pending}
                onPress={onRefreshPrice}
                style={styles.refresh}
              >
                <Text style={styles.refreshText}>시세 다시 불러오기</Text>
              </ActionPressable>
            ) : null}
          </>
        ) : directionText ? (
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
          onChangeText={(value) => edit(() => {
            setSize(value);
            setChosenRatio(null);
          })}
          keyboardType="decimal-pad"
          placeholder={crypto ? '매수 금액 입력' : '수량 입력'}
          onFieldFocus={onInputFocus}
          onBlur={onInputBlur}
        />
        {crypto ? <Text style={styles.helper}>수수료를 제외한 매수 원금이에요.</Text>
          : executionType === 'limit' ? <Text style={styles.helper}>지정가 발동은 정수 수량만 가능해요.</Text> : null}
      </View>
      <OrderRatioControls
        testID="conditional-ratio"
        label={crypto ? '매수 금액 비율' : '수량 비율'}
        accessibilityLabel={crypto ? '매수 금액 비율, 주문 가능 금액 기준' : '주문 수량 비율, 주문 가능 금액 기준'}
        pickLabel={crypto ? '주문 가능 금액의' : '주문 가능 수량'}
        tint={crypto ? undefined : BUY_COLOR}
        value={shownRatio}
        active={activeRatio}
        disabled={ratioDisabled}
        reason={blockedReason || createBlocked ? null : ratioBlock}
        notice={ratioNotice}
        onChange={applyRatio}
      />
      <Text style={styles.helper}>
        현재 주문 가능 {buyAvailable !== null ? formatCurrency(buyAvailable, currency) : '-'} · 감시 중에는 금액을 예약하지 않아요
      </Text>
      {blockedReason || createBlocked ? (
        <Text testID="conditional-blocked" style={styles.error}>{blockedReason ?? createBlocked}</Text>
      ) : null}
      {typed && draftError && draftError !== directionError ? <Text testID="conditional-input-error" style={styles.error}>{draftError}</Text> : null}
      {directionNotice ? <Text testID="conditional-direction-changed" accessibilityLiveRegion="polite" style={styles.warning}>{directionNotice}</Text> : null}
      {error ? (
        <ErrorNotice error={error.cause}
          message={error.uncertain ? UNCERTAIN_CREATE
            : getConditionalRegistrationErrorMessage(getApiErrorCode(error.cause)) ?? getErrorMessageFromCode(getApiErrorCode(error.cause))}
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
  notice: { fontSize: 12, lineHeight: 17, color: semantic.info },
  refresh: {
    alignSelf: 'flex-start',
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshText: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: semantic.text },
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
