import React, { useState } from 'react';
import { Text, View } from '../../../theme/native';
import { semantic } from '../../../theme/tokens';
import CTAButton from '../../../components/common/CTAButton';
import type { EntryTpSlDraftDto } from '../entryTpSlApi';
import {
  EMPTY_TP_SL_LEG,
  TP_SL_KINDS,
  TP_SL_KIND_LABEL,
  formatTpSlQuantity,
  getTpSlLegError,
  quantityForPercent,
  tpSlCountSummary,
  tpSlWatchesRise,
  type TpSlDirection,
  type TpSlKind,
  type TpSlLegDraft,
} from '../tpSlModel';
import { formatDisplayDecimal } from '../../../utils/format';
import TpSlLegFields from './TpSlLegFields';
import TpSlRow from './TpSlRow';

const freshLegs = (): Record<TpSlKind, TpSlLegDraft> => ({ take_profit: EMPTY_TP_SL_LEG, stop_loss: EMPTY_TP_SL_LEG });

/** Whether the order form's drafts still fit its current limit price. */
export function getDraftTpSlError(drafts: readonly EntryTpSlDraftDto[], direction: TpSlDirection, entryPrice: string | null) {
  for (const [index, draft] of drafts.entries()) {
    const message = getTpSlLegError({
      kind: draft.kind,
      draft: { enabled: true, triggerPrice: draft.triggerPrice, percent: draft.ratio },
      direction,
      mode: 'ratio',
      basis: null,
      scale: 8,
      existing: drafts.filter((_, other) => other !== index).map((row) => ({ kind: row.kind, triggerPrice: row.triggerPrice, ratioPercent: row.ratio })),
      entryPrice,
    });
    if (message) return message;
  }
  return null;
}

/**
 * 손절가/익절가 of an entry being created (BUY Limit, Futures limit entry):
 * plans kept in the order form and sent with the order, so they exist from
 * the moment the order is accepted (no gap a fill could fall into). Each is a
 * share of whatever the entry actually fills; after the order is accepted the
 * same plans are managed from its pending card.
 */
export default function DraftTpSl({ drafts, onChange, direction, entryPrice, expectedQuantity, scale, unit, currency, blockedReason,
  onInputFocus, onInputBlur, submitRef }: {
  drafts: readonly EntryTpSlDraftDto[];
  onChange: (drafts: EntryTpSlDraftDto[]) => void;
  direction: TpSlDirection;
  /** The form's limit price; null until it is a valid price. */
  entryPrice: string | null;
  /** If the entry fills completely (display only); null when unknown. */
  expectedQuantity: string | null;
  scale: number;
  unit: string;
  currency: string;
  /** Server/learning gates the form resolved; null when plans may be added. */
  blockedReason: string | null;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
  submitRef?: React.RefObject<View | null>;
}) {
  const [legs, setLegs] = useState(freshLegs);
  const existing = drafts.map((row) => ({ kind: row.kind, triggerPrice: row.triggerPrice, ratioPercent: row.ratio }));
  const patch = (kind: TpSlKind, value: Partial<TpSlLegDraft>) =>
    setLegs((previous) => ({ ...previous, [kind]: { ...previous[kind], ...value } }));
  const active = TP_SL_KINDS.filter((kind) => legs[kind].enabled);
  const legError = (kind: TpSlKind) => getTpSlLegError({ kind, draft: legs[kind], direction, mode: 'ratio', basis: null, scale, existing, entryPrice });
  const draftError = !entryPrice ? '지정가를 먼저 입력해 주세요.'
    : active.length === 0 ? '익절가 또는 손절가 중 하나 이상을 선택해주세요.'
    : active.map(legError).find((message) => message !== null) ?? null;
  const add = () => {
    if (blockedReason || draftError) return;
    onChange([...drafts, ...active.map((kind) => ({ kind, triggerPrice: legs[kind].triggerPrice.trim(), ratio: legs[kind].percent }))]);
    setLegs(freshLegs());
  };
  const listError = drafts.length ? getDraftTpSlError(drafts, direction, entryPrice) : null;
  return (
    <View style={styles.body} testID="tp-sl-draft">
      <Text style={styles.notice}>주문이 접수되면 함께 등록되고, 체결 후 활성화돼요. 실제 체결된 수량에 비율을 적용해요.</Text>
      {expectedQuantity ? <Text style={styles.helper}>체결 예정 수량 {formatTpSlQuantity(expectedQuantity, scale)} {unit}</Text> : null}
      {drafts.length ? (
        <View style={styles.list} testID="tp-sl-drafts">
          <Text style={styles.section}>주문과 함께 등록 · {tpSlCountSummary(drafts)}</Text>
          {drafts.map((draft, index) => (
            <TpSlRow key={`${draft.kind}:${draft.triggerPrice}:${index}`} testID={`tp-sl-draft-${index}`}
              title={`${TP_SL_KIND_LABEL[draft.kind]} · ${formatDisplayDecimal(draft.triggerPrice)} ${currency} ${tpSlWatchesRise(direction, draft.kind) ? '이상' : '이하'}`}
              detail={`체결 수량의 ${draft.ratio}%`}
              state="주문과 함께 등록"
              cancelLabel="삭제"
              confirm={false}
              onCancel={() => onChange(drafts.filter((_, other) => other !== index))} />
          ))}
          {listError ? <Text testID="tp-sl-drafts-error" style={styles.error}>{listError}</Text> : null}
        </View>
      ) : null}
      <TpSlLegFields
        legs={legs}
        onPatch={patch}
        disabled={!!blockedReason}
        ratioDisabled={false}
        currency={currency}
        shareLabel="체결 수량"
        quantityText={(kind, leg) => {
          const expected = quantityForPercent(expectedQuantity, leg.percent, scale);
          return `체결 수량의 ${leg.percent}%${expected ? ` · 전량 체결 시 ${formatTpSlQuantity(expected, scale)} ${unit}` : ''}`;
        }}
        error={legError}
        placeholder={(kind) => tpSlWatchesRise(direction, kind) ? '지정가보다 높은 가격' : '지정가보다 낮은 가격'}
        onInputFocus={onInputFocus}
        onInputBlur={onInputBlur}
      />
      {blockedReason ? <Text testID="tp-sl-blocked" style={styles.error}>{blockedReason}</Text>
        : active.length && draftError ? <Text testID="tp-sl-draft-error" style={styles.error}>{draftError}</Text> : null}
      <View ref={submitRef} collapsable={false}>
        <CTAButton testID="tp-sl-submit" label="추가하기" state={!blockedReason && !draftError ? 'enabled' : 'disabled'} onPress={add} />
      </View>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  body: { gap: 12, minWidth: 0 },
  helper: { fontSize: 12, lineHeight: 17, color: semantic.secondary, flexShrink: 1 },
  notice: { fontSize: 12, lineHeight: 17, color: semantic.info, flexShrink: 1 },
  section: { fontSize: 13, lineHeight: 19, fontWeight: '700', color: semantic.text },
  list: { gap: 8, minWidth: 0 },
  error: { fontSize: 12, lineHeight: 17, color: semantic.error },
} as const;
