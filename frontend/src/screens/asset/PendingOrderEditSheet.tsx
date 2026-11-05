import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import SegmentedControl from '../../components/common/SegmentedControl';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import OrderNumberInput from '../order/OrderNumberInput';
import OrderRatioControls from '../order/OrderRatioControls';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { checkEdit, editQuantityScale, wholeShareNotice } from '../../features/order/pendingEdit';
import { getTradingAccountPositions, modifyPendingOrder } from '../../features/tradingAccount/api';
import { getAccountHoldings } from '../../features/tradingAccount/holdings';
import { quantityForPercent } from '../../features/conditional/tpSlModel';
import { ratioOfCapacity } from '../../features/conditional/conditionalRatio';
import { formatPendingQuantity, type EditValues, type PendingItem } from '../../features/order/pendingItems';
import { createIdempotencyKey } from '../../utils/idempotency';
import { getApiErrorCode, getApiErrorInfo, getApiErrorStatus, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';

type Editable = Extract<PendingItem['edit'], { editable: true }>;
type Command = { key: string; body: string; uncertain: boolean };

/**
 * 설정 변경 (2026-11-05): the pending order or setting's current terms in a
 * sheet, changed within what its kind allows (a stop-loss/take-profit stays
 * market, a plain limit order stays limit), reviewed as before → after, then
 * sent as ONE server change (never a cancel plus a new order). A result the
 * app could not confirm is retried with the same key, so it applies once.
 */
export default function PendingOrderEditSheet({ accountId, item, onClose, onChanged }: {
  accountId: string;
  item: PendingItem | null;
  onClose: () => void;
  /** The server committed (or replayed) the change. */
  onChanged: (item: PendingItem) => void;
}) {
  const last = useRef<PendingItem | null>(null);
  if (item) last.current = item;
  const shown = item ?? last.current;
  const [busy, setBusy] = useState(false);
  return (
    <SheetPortal>
      <InlineBottomSheet testID="pending-edit-sheet" title="설정 변경" visible={!!item} dismissible={!busy} onClose={onClose}>
        {shown && shown.edit.editable ? (
          <EditBody key={`${accountId}:${shown.key}:${shown.edit.revision}`} accountId={accountId} item={shown} spec={shown.edit}
            onBusyChange={setBusy} onChanged={onChanged} onClose={onClose} />
        ) : null}
      </InlineBottomSheet>
    </SheetPortal>
  );
}

function EditBody({ accountId, item, spec, onBusyChange, onChanged, onClose }: {
  accountId: string;
  item: PendingItem;
  spec: Editable;
  onBusyChange: (busy: boolean) => void;
  onChanged: (item: PendingItem) => void;
  onClose: () => void;
}) {
  const scroll = useFocusedInputScroll();
  const [draft, setDraft] = useState<EditValues>(spec.initial);
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const command = useRef<Command | null>(null);
  const alive = useRef(true);
  const session = useRef(getSessionGeneration());
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { onBusyChange(pending); }, [onBusyChange, pending]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const check = checkEdit(spec, draft);
  const set = (patch: EditValues) => {
    if (pending) return;
    setDraft((current) => ({ ...current, ...patch }));
    setMessage(null);
    setFailure(null);
  };
  const execution = spec.executions.length === 1 ? spec.executions[0] : draft.executionType;
  const quantityScale = editQuantityScale(spec, execution);
  const whole = wholeShareNotice(spec, draft);
  const save = async () => {
    if (!('body' in check) || pending) return;
    const body = JSON.stringify(check.body);
    // The same change keeps its key across retries; another change gets a new one.
    const next = command.current?.body === body ? command.current : { key: createIdempotencyKey('pending-modify'), body, uncertain: false };
    command.current = next;
    setPending(true);
    setFailure(null);
    try {
      await modifyPendingOrder(accountId, spec.target, { ...check.body, idempotencyKey: next.key, expectedRevision: spec.revision });
      if (!alive.current || !isCurrentSession(session.current)) return;
      onChanged(item);
    } catch (error) {
      if (!alive.current || !isCurrentSession(session.current)) return;
      // No response, or a server failure: the change may have committed.
      next.uncertain = !getApiErrorInfo(error).hasResponse || (getApiErrorStatus(error) ?? 0) >= 500;
      setFailure(error);
    } finally {
      if (alive.current) setPending(false);
    }
  };
  const code = failure ? getApiErrorCode(failure) : null;
  const failureMessage = !failure ? null
    : command.current?.uncertain ? '변경 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.'
    : getErrorMessageFromCode(code);
  // The order moved on (filled, triggered, canceled or changed elsewhere): the list shows its latest state.
  const stale = code === 'PENDING_ORDER_NOT_MODIFIABLE' || code === 'PENDING_ORDER_CHANGED';
  const unit = spec.size === 'amount' ? (spec.currency === 'KRW' ? '원' : spec.currency) : spec.size === 'ratio' ? '%' : spec.quantityUnit;
  // 이상/이하 is the user's for a condition; a stop-loss/take-profit's follows its kind.
  const fixedTrigger = spec.trigger && 'condition' in spec.trigger ? spec.trigger : null;
  return (
    <View style={styles.viewport}>
      <ScrollView testID="pending-edit-scroll" ref={scroll.scrollRef} onLayout={scroll.revealFocusedInput}
        onContentSizeChange={scroll.revealFocusedInput} onScroll={scroll.onScroll} scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="none" style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.heading}>
          <Text style={styles.name}>{item.assetName}</Text>
          <Text style={styles.meta}>{item.typeLabel} · {item.sideLabel}</Text>
        </View>
        {step === 'edit' ? (
          <>
            {spec.trigger ? (
              <View style={styles.field}>
                <Text style={styles.label}>{spec.trigger.label}</Text>
                {!fixedTrigger ? (
                  <SegmentedControl testID="pending-edit-direction" accessibilityLabel="감시 방향" compact
                    value={draft.triggerCondition ?? 'at_or_above'} onChange={(value) => set({ triggerCondition: value })}
                    options={[{ key: 'at_or_above', label: '이상', testID: 'pending-edit-direction-at_or_above' },
                      { key: 'at_or_below', label: '이하', testID: 'pending-edit-direction-at_or_below' }]} />
                ) : (
                  <Text style={styles.hint} testID="pending-edit-direction-fixed">
                    {fixedTrigger.condition === 'at_or_below' ? '이하' : '이상'} 도달 시 실행 · {fixedTrigger.kind === 'stop_loss' ? '손절가' : '익절가'}는 방향이 정해져 있어요
                  </Text>
                )}
                <OrderNumberInput testID="pending-edit-trigger-price" accessibilityLabel={spec.trigger.label} value={draft.triggerPrice ?? ''}
                  onChangeText={(value) => set({ triggerPrice: value })} keyboardType="decimal-pad" editable={!pending}
                  onFieldFocus={scroll.onInputFocus} onBlur={scroll.onInputBlur} unit={spec.currency === 'KRW' ? '원' : spec.currency} style={styles.input} />
                {spec.trigger.hint ? <Text style={styles.hint} testID="pending-edit-trigger-hint">{spec.trigger.hint}</Text> : null}
              </View>
            ) : null}
            <View style={styles.field}>
              <Text style={styles.label}>{spec.executionLabel}</Text>
              {spec.executions.length > 1 ? (
                <SegmentedControl testID="pending-edit-execution" accessibilityLabel={spec.executionLabel} compact
                  value={draft.executionType ?? 'market'} onChange={(value) => set({ executionType: value })}
                  options={[{ key: 'market', label: '시장가', testID: 'pending-edit-execution-market' },
                    { key: 'limit', label: '지정가', testID: 'pending-edit-execution-limit' }]} />
              ) : (
                <Text style={styles.hint} testID="pending-edit-execution-fixed">
                  {execution === 'limit' ? '지정가' : '시장가'} · 이 {item.kindLabel}의 실행 유형은 바꿀 수 없어요
                </Text>
              )}
              {execution === 'limit' ? (
                <OrderNumberInput testID="pending-edit-limit-price" accessibilityLabel="지정가" value={draft.limitPrice ?? ''}
                  onChangeText={(value) => set({ limitPrice: value })} keyboardType="decimal-pad" editable={!pending}
                  onFieldFocus={scroll.onInputFocus} onBlur={scroll.onInputBlur} unit={spec.currency === 'KRW' ? '원' : spec.currency} style={styles.input} />
              ) : null}
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>{spec.size === 'amount' ? '금액' : spec.size === 'ratio' ? '체결 수량 중 비율' : '수량'}</Text>
              <OrderNumberInput testID={`pending-edit-${spec.size}`} accessibilityLabel={spec.size === 'amount' ? '금액' : spec.size === 'ratio' ? '비율' : '수량'}
                value={draft[spec.size] ?? ''} onChangeText={(value) => set({ [spec.size]: value })}
                keyboardType={spec.size === 'ratio' || quantityScale === 0 ? 'number-pad' : 'decimal-pad'} editable={!pending}
                onFieldFocus={scroll.onInputFocus} onBlur={scroll.onInputBlur} unit={unit} style={styles.input} />
              {whole ? (
                <Text testID="pending-edit-quantity-whole" accessibilityLiveRegion="polite" style={whole.tone === 'warning' ? styles.warning : styles.hint}>
                  {whole.text}
                </Text>
              ) : null}
              {spec.size === 'amount' ? <Text style={styles.hint}>수량은 새 지정가로 다시 계산돼요 (소수점 아래는 버림).</Text> : null}
              {spec.holdingShare && spec.size === 'quantity' ? (
                <HoldingShare accountId={accountId} assetId={spec.holdingShare.assetId} quantity={draft.quantity ?? ''}
                  scale={quantityScale} unit={spec.quantityUnit} disabled={pending} onPick={(quantity) => set({ quantity })} />
              ) : null}
            </View>
            {message ? <Text testID="pending-edit-message" accessibilityLiveRegion="polite" style={styles.error}>{message}</Text> : null}
            <View ref={scroll.submitRef} collapsable={false}>
              <CTAButton testID="pending-edit-review" label="변경 내용 확인" state={pending ? 'disabled' : 'enabled'}
                onPress={() => { if ('message' in check) setMessage(check.message); else { setStep('review'); setMessage(null); } }} />
            </View>
          </>
        ) : (
          <>
            <View style={styles.review} testID="pending-edit-changes">
              {'changes' in check ? check.changes.map((change) => (
                <View key={change.label} style={styles.change}>
                  <Text style={styles.label}>{change.label}</Text>
                  <Text style={styles.changeValue}>{change.before} → {change.after}</Text>
                </View>
              )) : null}
            </View>
            <Text style={styles.hint}>저장할 때 최신 상태를 다시 확인해요. 그 사이 체결·발동·취소되었다면 변경하지 않고 알려드려요.</Text>
            {failureMessage ? (
              <ErrorNotice testID="pending-edit-error" error={failure} message={failureMessage} style={styles.error} />
            ) : null}
            <View style={styles.actions} ref={scroll.submitRef} collapsable={false}>
              <CTAButton testID="pending-edit-back" variant="neutral" label="다시 수정" style={styles.flex}
                state={pending || command.current?.uncertain ? 'disabled' : 'enabled'} onPress={() => { setStep('edit'); setFailure(null); }} />
              {stale ? (
                <CTAButton testID="pending-edit-close" label="닫기" style={styles.flex} onPress={onClose} />
              ) : (
                <CTAButton testID="pending-edit-save" label={command.current?.uncertain ? '같은 요청으로 다시 확인' : '저장하기'} style={styles.flex}
                  state={pending ? 'loading' : check.ok ? 'enabled' : 'disabled'} onPress={() => void save()} />
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * 수량 비율 of a Spot stop-loss/take-profit (2026-11-05): the order form's
 * ratio controls over this account's TOTAL holding of the asset — nothing is
 * reserved while watching, so other orders' reservations never shrink the
 * basis. Input help only: the typed quantity stays the value (opening
 * changes nothing, a pick writes one rounded down as the registration does,
 * typing moves the thumb), and the server re-checks the holding and the
 * per-kind totals when the change is saved. Without a successful read of
 * the holding nothing is computed.
 */
function HoldingShare({ accountId, assetId, quantity, scale, unit, disabled, onPick }: {
  accountId: string;
  assetId: string;
  quantity: string;
  scale: number;
  unit: string;
  disabled: boolean;
  onPick: (quantity: string) => void;
}) {
  // The order screen's holdings read (same key and contract).
  const holdings = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.holdings(accountId),
    queryFn: () => getAccountHoldings(accountId, getTradingAccountPositions),
    refetchInterval: 4000,
  });
  const data = holdings.data?.tradingAccountId === accountId ? holdings.data : null;
  // A failed read never stands in for the holding, not even with its last answer.
  const holding = !data || holdings.isError ? null : data.positions.find((row) => row.assetId === assetId)?.quantity ?? '0';
  const held = !!holding && /[1-9]/u.test(holding);
  // The pick that produced the quantity (kept only while it still does), and
  // the quantity a pick too small to apply left unchanged.
  const [chosen, setChosen] = useState<number | null>(null);
  const [tooSmall, setTooSmall] = useState<string | null>(null);
  const at = (percent: number) => (held ? quantityForPercent(holding, percent, scale) : null);
  const active = chosen !== null && (chosen === 0 ? quantity === '' : at(chosen) === quantity) ? chosen : null;
  const shown = active !== null ? active / 100 : held ? ratioOfCapacity(quantity, holding) : 0;
  const pick = (ratio: number) => {
    if (disabled || !held || !Number.isFinite(ratio)) return;
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    const next = percent === 0 ? '' : at(percent);
    if (next === null) { setTooSmall(quantity); return; }
    setTooSmall(null);
    setChosen(percent);
    onPick(next);
  };
  const reason = disabled ? null
    : holding === null ? holdings.isError ? '보유 수량을 확인하지 못해 비율로 정할 수 없어요. 수량은 직접 입력할 수 있어요.' : '보유 수량을 확인하는 중이에요.'
    : !held ? '보유 수량이 없어 비율로 정할 수 없어요.'
    : null;
  // Never shrunk for the user: the server refuses a change above the holding.
  const over = held && /^\d+(\.\d+)?$/u.test(quantity.trim()) && Number(quantity) > Number(holding);
  return (
    <View style={styles.share}>
      <OrderRatioControls testID="pending-edit-quantity-ratio" label="수량 비율" accessibilityLabel="매도 수량 비율, 보유 수량 기준"
        pickLabel="보유 수량의" value={shown} active={active !== null ? active / 100 : null} disabled={disabled || !held} reason={reason}
        notice={tooSmall !== null && tooSmall === quantity ? '선택한 비율의 수량이 최소 단위보다 적어요. 비율을 높이거나 수량을 직접 입력해 주세요.' : null}
        onChange={pick} />
      {held ? <Text style={styles.hint} testID="pending-edit-quantity-basis">현재 보유 {formatPendingQuantity(holding, unit)} 기준</Text> : null}
      {over ? (
        <Text style={styles.warning} testID="pending-edit-quantity-over">
          설정 수량이 현재 보유 수량보다 많아요. 변경하려면 수량을 보유 수량 이하로 맞춰 주세요.
        </Text>
      ) : null}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  viewport: { flexShrink: 1, minHeight: 0 },
  scroll: { flexGrow: 0 },
  content: { gap: 14, paddingTop: 4, paddingBottom: 8 },
  heading: { gap: 2, minWidth: 0 },
  name: { fontSize: 17, lineHeight: 24, fontWeight: '700', color: semantic.text, flexShrink: 1 },
  meta: { fontSize: 13, lineHeight: 19, color: semantic.secondary, flexShrink: 1 },
  field: { gap: 8, minWidth: 0 },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: semantic.text },
  hint: { fontSize: 13, lineHeight: 19, color: semantic.secondary, flexShrink: 1 },
  warning: { fontSize: 13, lineHeight: 19, color: semantic.warning, flexShrink: 1 },
  error: { fontSize: 13, lineHeight: 19, color: semantic.warning },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 10, padding: 12, fontSize: 17, minHeight: 48 },
  share: { gap: 4, minWidth: 0 },
  review: { gap: 10, borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14 },
  change: { gap: 2, minWidth: 0 },
  changeValue: { fontSize: 15, lineHeight: 22, color: semantic.text, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
} as const;
