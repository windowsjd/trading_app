import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, View, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getProtections } from '../../features/conditional/api';
import {
  createConditionalSellOrder,
  type ConditionalSellCapabilitiesDto,
  type ConditionalSellCreateDto,
  type ConditionalSellOrderDto,
} from '../../features/conditional/conditionalSellApi';
import { getConditionalSellKindLabel, getConditionalSellResultNotice } from '../../features/conditional/conditionalSellDisplay';
import {
  EMPTY_PROTECTION_LEG,
  PROTECTION_KINDS,
  PROTECTION_KIND_LABEL,
  formatProtectionQuantity,
  getProtectionLegError,
  isProtectionAlreadyMet,
  liveProtectionRows,
  liveProtectionTotal,
  protectionRoom,
  quantityAtPercent,
  type LiveProtectionRow,
  type ProtectionKind,
  type ProtectionLegDraft,
} from '../../features/conditional/sellProtectionDraft';
import { emitOrderFillEvent } from '../../features/order/fillEvents';
import { SELL_COLOR } from '../../features/order/sideColors';
import { captureQuestGuideCommand } from '../../features/quest/questGuideBridge';
import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import QuestTarget from '../../features/quest/QuestTarget';
import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import { getApiErrorCode, getApiErrorInfo, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatDisplayDecimal } from '../../utils/format';
import OrderNumberInput, { orderInputStyle } from './OrderNumberInput';
import QuantityRatioSlider from './QuantityRatioSlider';

type LearningGate = { allowed: boolean; locked: boolean; message: string | null; guard: (work: () => void) => void };
type Request = {
  accountId: string;
  epoch: number;
  body: ConditionalSellCreateDto;
  reportQuestCommand: ReturnType<typeof captureQuestGuideCommand>;
};

const RATIOS = [25, 50, 75, 100] as const;
const TEST_ID: Record<ProtectionKind, string> = { take_profit: 'sell-take-profit', stop_loss: 'sell-stop-loss' };
const BODY_KEY: Record<ProtectionKind, 'takeProfit' | 'stopLoss'> = { take_profit: 'takeProfit', stop_loss: 'stopLoss' };
const UNCERTAIN_CREATE = '등록 결과를 확인하지 못했어요. 대기 목록의 매도 설정을 먼저 확인해 주세요. 같은 내용으로 다시 누르면 중복 없이 다시 확인해요.';
const freshLegs = (): Record<ProtectionKind, ProtectionLegDraft> => ({ take_profit: EMPTY_PROTECTION_LEG, stop_loss: EMPTY_PROTECTION_LEG });

/**
 * 손절가/익절가 설정 (SELL 주문방식): an independent take-profit and/or
 * stop-loss on an open KRX/crypto Spot holding, each with its own trigger
 * price and share of today's holding. Market execution only; nothing is
 * reserved while watching. Per holding the live take-profits (and separately
 * the stop-losses) target at most the holding; the server re-checks every
 * rule, sizes the sale when a price is reached and never sells more than is
 * then unreserved. Not the whole-position OCO protection.
 */
export default function SellProtectionForm({
  accountId,
  asset,
  capabilities,
  blockedReason,
  holding,
  available,
  reserved,
  liveRows,
  currentPrice,
  learning,
  onInputFocus,
  onInputBlur,
}: {
  accountId: string;
  asset: { assetType?: string | null; settlementCurrency?: string | null; symbol?: string | null; id: string };
  capabilities: ConditionalSellCapabilitiesDto | null;
  /** Account/asset/holding gates the order form already resolved. */
  blockedReason: string | null;
  /** The server's holding quantity; null while unknown. */
  holding: string | null;
  available: string | null;
  reserved: string | null;
  /** This account's live SELL settings (the order form's list query); null while unknown. */
  liveRows: readonly LiveProtectionRow[] | null;
  /** The screen's current price, only for "already met" hints. */
  currentPrice: string | null;
  learning: LearningGate;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
}) {
  const queryClient = useQueryClient();
  const guide = useQuestGuide();
  const { fontScale } = useWindowDimensions();
  const currency = asset.settlementCurrency ?? '';
  const unit = asset.assetType === 'crypto' ? (asset.symbol ?? '').replace(/USDT$/u, '') : '주';
  const [legs, setLegs] = useState(freshLegs);
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

  // A live whole-position OCO protection and these settings never share a
  // holding (server PROTECTION_CONFLICT): say so before the user fills the form.
  const ocoQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.protections.list(accountId, 'spot', asset.id),
    queryFn: ({ signal }) => getProtections(accountId, 'spot', asset.id, false, signal),
    retry: false,
  });
  const ocoActive = !ocoQuery.isError && ocoQuery.data?.tradingAccountId === accountId
    && ocoQuery.data.groups.some((group) => group.status === 'active' || group.status === 'holding');

  const mutation = useMutation({
    mutationFn: (request: Request) => createConditionalSellOrder(request.accountId, request.body),
    retry: false,
    onSuccess: async (result, request) => {
      // The settings are the server's record now, wherever the user went.
      for (const row of result.conditionalOrders)
        emitOrderFillEvent({ kind: 'watch', side: 'sell', accountId: request.accountId, watchId: row.id });
      request.reportQuestCommand({ kind: 'protection', accountId: request.accountId, assetId: asset.id,
        summary: '손절가/익절가 설정이 서버에 등록됐어요.' });
      if (isCurrent(request)) {
        actionRef.current = null;
        setRegistered(result.conditionalOrders);
        setError(null);
        setLegs(freshLegs());
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
  const patch = (kind: ProtectionKind, value: Partial<ProtectionLegDraft>) =>
    edit(() => setLegs((previous) => ({ ...previous, [kind]: { ...previous[kind], ...value } })));

  const active = PROTECTION_KINDS.filter((kind) => legs[kind].enabled);
  const legError = (kind: ProtectionKind) => getProtectionLegError({ kind, draft: legs[kind], holding, assetId: asset.id, liveRows });
  const draftError = active.length === 0
    ? '익절가 또는 손절가 중 하나 이상을 선택해주세요.'
    : active.map(legError).find((message) => message !== null) ?? null;
  const createBlocked = !capabilities?.protection?.canCreate
    ? '현재 손절가/익절가를 새로 등록할 수 없어요.'
    : ocoActive
      ? '이 종목에는 기존 TP/SL(OCO) 보호가 있어 함께 설정할 수 없어요. 아래 대기 목록의 TP/SL에서 기존 보호를 취소한 뒤 등록해 주세요.'
      : null;
  const canSubmit = !blockedReason && !createBlocked && !draftError && !pending;
  const result = registered ? getConditionalSellResultNotice(registered) : null;
  const guided = guide?.active?.quest === 'protection' && guide.active.accountId === accountId && guide.active.assetId === asset.id;
  useTradingGuideFacts({ screen: 'protection', accountId, assetId: asset.id, protectionEditing: true, tpSlReady: canSubmit,
    pending, blocked: !!(blockedReason ?? createBlocked) }, guided);

  const submit = () => {
    if (!learning.allowed && !actionRef.current) {
      learning.guard(() => undefined);
      return;
    }
    if (!canSubmit && !(actionRef.current && error)) return;
    if (pending || blockedReason || createBlocked) return;
    setError(null);
    if (!actionRef.current) {
      // Each share becomes a fixed quantity now; the server stores exactly this.
      const leg = (kind: ProtectionKind) => ({ triggerPrice: legs[kind].triggerPrice.trim(), executionType: 'market' as const,
        quantity: quantityAtPercent(holding, legs[kind].percent) ?? '' });
      const body: ConditionalSellCreateDto = {
        kind: 'protection',
        assetId: asset.id,
        ...Object.fromEntries(active.map((kind) => [BODY_KEY[kind], leg(kind)])),
        idempotencyKey: createIdempotencyKey('sell_protection'),
      };
      actionRef.current = { accountId, epoch: scopeRef.current.epoch, body, reportQuestCommand: captureQuestGuideCommand() };
    }
    mutation.mutate(actionRef.current);
  };

  const section = (kind: ProtectionKind) => {
    const leg = legs[kind];
    const id = TEST_ID[kind];
    const name = PROTECTION_KIND_LABEL[kind];
    const quantity = quantityAtPercent(holding, leg.percent);
    const live = liveProtectionRows(liveRows, asset.id, kind);
    const room = protectionRoom(holding, liveRows, asset.id, kind);
    const problem = leg.enabled && (leg.triggerPrice.trim() || leg.percent > 0) ? legError(kind) : null;
    const over = quantity !== null && available !== null && Number(quantity) > Number(available);
    return (
      <View key={kind} style={styles.section} testID={`${id}-section`}>
        <ActionPressable
          testID={`${id}-toggle`}
          accessibilityRole="checkbox"
          accessibilityLabel={`${name}가 설정, ${kind === 'take_profit' ? '이 가격 이상이면 시장가 매도' : '이 가격 이하이면 시장가 매도'}`}
          accessibilityState={{ checked: leg.enabled, disabled: pending }}
          aria-checked={leg.enabled}
          disabled={pending}
          onPress={() => patch(kind, leg.enabled ? { ...EMPTY_PROTECTION_LEG } : { enabled: true })}
          style={[styles.toggle, leg.enabled && styles.toggleOn]}
        >
          <View style={[styles.toggleBox, leg.enabled && styles.toggleBoxOn]}>
            <Text style={styles.toggleMark}>{leg.enabled ? '✓' : ''}</Text>
          </View>
          <View style={styles.toggleCopy}>
            <Text style={styles.toggleTitle}>{name}가 설정</Text>
            <Text style={styles.helper}>
              {kind === 'take_profit' ? '현재가가 익절가 이상이 되면 정한 수량을 시장가로 매도해요.' : '현재가가 손절가 이하가 되면 정한 수량을 시장가로 매도해요.'}
            </Text>
          </View>
        </ActionPressable>
        {leg.enabled ? (
          <View style={styles.fields}>
            <View style={styles.group}>
              <Text style={styles.label}>{name}가 ({currency})</Text>
              <OrderNumberInput
                testID={`${id}-trigger-price`}
                accessibilityLabel={`${name}가 ${currency}`}
                editable={!pending}
                style={orderInputStyle}
                value={leg.triggerPrice}
                onChangeText={(value) => patch(kind, { triggerPrice: value })}
                keyboardType="decimal-pad"
                placeholder={kind === 'take_profit' ? '현재가보다 높은 가격' : '현재가보다 낮은 가격'}
                onFieldFocus={onInputFocus}
                onBlur={onInputBlur}
              />
              {isProtectionAlreadyMet(kind, leg.triggerPrice, currentPrice) ? (
                <Text testID={`${id}-already-met`} style={styles.warning}>현재가가 이미 이 가격에 도달해 등록되지 않을 수 있어요.</Text>
              ) : null}
            </View>
            <View style={styles.group}>
              <View style={styles.ratioLabel}>
                <Text style={styles.label}>{name} 수량</Text>
                <Text testID={`${id}-percent`} style={[styles.label, styles.ratioValue, { flexBasis: 36 * fontScale }]}>{leg.percent}%</Text>
              </View>
              <QuantityRatioSlider
                testID={`${id}-slider`}
                accessibilityLabel={`${name} 수량 비율`}
                value={leg.percent / 100}
                disabled={pending || holding === null}
                onChange={(ratio) => patch(kind, { percent: Math.max(0, Math.min(100, Math.round(ratio * 100))) })}
              />
              <View style={styles.ratios}>
                {RATIOS.map((ratio) => (
                  <ActionPressable
                    key={ratio}
                    testID={`${id}-ratio-${ratio}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${name} 수량 보유의 ${ratio}%`}
                    accessibilityState={{ selected: leg.percent === ratio, disabled: pending || holding === null }}
                    aria-pressed={leg.percent === ratio}
                    disabled={pending || holding === null}
                    hitSlop={{ top: 6, bottom: 6 }}
                    onPress={() => patch(kind, { percent: ratio })}
                    style={[styles.ratioButton, { flexBasis: 34 * fontScale }, leg.percent === ratio && styles.ratioSelected]}
                  >
                    <Text style={[styles.ratioText, leg.percent === ratio && styles.ratioTextSelected]}>{ratio}%</Text>
                  </ActionPressable>
                ))}
              </View>
              <Text testID={`${id}-quantity`} style={styles.quantity}>
                주문 수량 {quantity ? `${formatProtectionQuantity(quantity)} ${unit}` : '-'}
              </Text>
              {live.length ? (
                <Text testID={`${id}-live`} style={styles.helper}>
                  감시 중인 {name} {live.length}건 · 합계 {formatProtectionQuantity(liveProtectionTotal(liveRows, asset.id, kind))} · 추가 가능 {formatProtectionQuantity(room)}
                </Text>
              ) : null}
              {over && !problem ? (
                <Text testID={`${id}-quantity-notice`} style={styles.warning}>
                  지금 발동하면 매도 가능 수량({formatDisplayDecimal(available)})만 매도돼요. 다른 주문이 예약한 수량은 쓰지 않아요.
                </Text>
              ) : null}
              {problem ? <Text testID={`${id}-error`} style={styles.error}>{problem}</Text> : null}
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.form} testID="sell-protection-form">
      <Text accessibilityRole="header" style={styles.title}>손절가/익절가 설정하기</Text>
      <QuestTarget id="protection-editor"><View style={styles.sections}>{PROTECTION_KINDS.map(section)}</View></QuestTarget>
      <Text testID="sell-intent-holding" style={styles.helper}>
        보유 {holding !== null ? formatDisplayDecimal(holding) : '-'}
        {available !== null ? ` · 매도 가능 ${formatDisplayDecimal(available)}` : ''}
        {reserved !== null && Number(reserved) > 0 ? ` (다른 주문 예약 ${formatDisplayDecimal(reserved)})` : ''}
      </Text>
      <View style={styles.policy} testID="sell-intent-policy">
        {[
          '설정한 가격에 도달하면 정한 수량을 시장가로 매도해요. 조건 충족은 체결이 아니며, 최종 가격은 그때의 시장가예요.',
          '익절과 손절은 서로 독립된 설정이에요. 하나가 실행돼도 나머지 설정은 취소되거나 바뀌지 않아요.',
          '가격을 다르게 해 여러 번 설정할 수 있고, 같은 종류 설정 수량의 합은 보유 수량을 넘을 수 없어요.',
          '실제 매도 수량은 발동 시점의 매도 가능 수량(보유 − 다른 주문 예약)을 넘지 않아요. 보유 수량을 모두 팔면 남은 설정은 함께 끝나요.',
          asset.assetType === 'crypto' ? '암호화폐는 Binance 현물 가격으로 감시해요.' : '한국주식은 정규장 시간의 신선한 시세로만 감시하고, 등록도 정규장 중에 할 수 있어요.',
        ].map((line) => (
          <Text key={line} style={styles.policyLine}>· {line}</Text>
        ))}
      </View>
      {blockedReason || createBlocked ? (
        <Text testID="sell-intent-blocked" style={styles.error}>{blockedReason ?? createBlocked}</Text>
      ) : null}
      {active.length === 0 ? <Text testID="sell-intent-input-error" style={styles.helper}>{draftError}</Text> : null}
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
              {getConditionalSellKindLabel(row.kind)}가 {formatDisplayDecimal(row.triggerPrice)} {currency} {row.kind === 'take_profit' ? '이상' : '이하'}이면 시장가 매도 · 수량 {formatProtectionQuantity(row.quantity)} {unit}
            </Text>
          ))}
          <Text style={styles.helper}>{result.next}</Text>
        </View>
      ) : null}
      <QuestTarget id="protection-submit"><CTAButton
        testID="sell-intent-submit"
        label={actionRef.current && error ? '같은 내용으로 다시 확인' : '확인'}
        style={{ backgroundColor: SELL_COLOR }}
        state={pending ? 'loading' : canSubmit || (actionRef.current && error && !blockedReason && !createBlocked) ? 'enabled' : 'disabled'}
        learningHint={learning.locked ? learning.message : null}
        onPress={submit}
      /></QuestTarget>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  form: { gap: 12, minWidth: 0 },
  title: { fontSize: 16, lineHeight: 23, fontWeight: '700', color: semantic.text },
  sections: { gap: 12, minWidth: 0 },
  section: { gap: 10, minWidth: 0 },
  fields: { gap: 10, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted, flexShrink: 1 },
  helper: { fontSize: 12, lineHeight: 17, color: semantic.secondary },
  warning: { fontSize: 12, lineHeight: 17, color: semantic.warning },
  error: { fontSize: 12, lineHeight: 17, color: semantic.error },
  quantity: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: semantic.text, fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  ratioLabel: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4, justifyContent: 'space-between' },
  // Room for 100% so digit changes never move the track during a drag.
  ratioValue: { flexShrink: 1, fontVariant: ['tabular-nums'] as 'tabular-nums'[], textAlign: 'right' },
  ratios: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 3, rowGap: 12, paddingVertical: 6 },
  ratioButton: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 32,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 6,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.raised,
  },
  ratioSelected: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  ratioText: { fontSize: 11, fontWeight: '600', color: semantic.text },
  ratioTextSelected: { color: semantic.onAccent },
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
