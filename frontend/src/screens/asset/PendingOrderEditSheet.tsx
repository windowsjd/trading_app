import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import SegmentedControl from '../../components/common/SegmentedControl';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import OrderNumberInput from '../order/OrderNumberInput';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { checkEdit } from '../../features/order/pendingEdit';
import { modifyPendingOrder } from '../../features/tradingAccount/api';
import type { EditValues, PendingItem } from '../../features/order/pendingItems';
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
  const fixedCondition = spec.trigger && 'condition' in spec.trigger ? spec.trigger.condition : null;
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
                <Text style={styles.label}>감시가격</Text>
                {!fixedCondition ? (
                  <SegmentedControl testID="pending-edit-direction" accessibilityLabel="감시 방향" compact
                    value={draft.triggerCondition ?? 'at_or_above'} onChange={(value) => set({ triggerCondition: value })}
                    options={[{ key: 'at_or_above', label: '이상' }, { key: 'at_or_below', label: '이하' }]} />
                ) : (
                  <Text style={styles.hint} testID="pending-edit-direction-fixed">
                    {fixedCondition === 'at_or_below' ? '이하' : '이상'} 도달 시 실행 · {item.typeLabel.includes('손절') ? '손절가' : '익절가'}는 방향이 정해져 있어요
                  </Text>
                )}
                <OrderNumberInput testID="pending-edit-trigger-price" accessibilityLabel="감시가격" value={draft.triggerPrice ?? ''}
                  onChangeText={(value) => set({ triggerPrice: value })} keyboardType="decimal-pad" editable={!pending}
                  onFieldFocus={scroll.onInputFocus} onBlur={scroll.onInputBlur} unit={spec.currency === 'KRW' ? '원' : spec.currency} style={styles.input} />
              </View>
            ) : null}
            <View style={styles.field}>
              <Text style={styles.label}>{spec.executionLabel}</Text>
              {spec.executions.length > 1 ? (
                <SegmentedControl testID="pending-edit-execution" accessibilityLabel={spec.executionLabel} compact
                  value={draft.executionType ?? 'market'} onChange={(value) => set({ executionType: value })}
                  options={[{ key: 'market', label: '시장가' }, { key: 'limit', label: '지정가' }]} />
              ) : (
                <Text style={styles.hint} testID="pending-edit-execution-fixed">
                  {execution === 'limit' ? '지정가' : '시장가'} · 이 {item.typeLabel}의 실행 유형은 바꿀 수 없어요
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
                keyboardType={spec.size === 'ratio' || spec.quantityScale === 0 ? 'number-pad' : 'decimal-pad'} editable={!pending}
                onFieldFocus={scroll.onInputFocus} onBlur={scroll.onInputBlur} unit={unit} style={styles.input} />
              {spec.size === 'amount' ? <Text style={styles.hint}>수량은 새 지정가로 다시 계산돼요 (소수점 아래는 버림).</Text> : null}
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
  error: { fontSize: 13, lineHeight: 19, color: semantic.warning },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 10, padding: 12, fontSize: 17, minHeight: 48 },
  review: { gap: 10, borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14 },
  change: { gap: 2, minWidth: 0 },
  changeValue: { fontSize: 15, lineHeight: 22, color: semantic.text, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
} as const;
