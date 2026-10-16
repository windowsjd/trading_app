import React from 'react';
import { Text, View, useWindowDimensions } from '../../../theme/native';
import { semantic } from '../../../theme/tokens';
import ActionPressable from '../../../components/common/ActionPressable';
import OrderNumberInput, { orderInputStyle } from '../../../screens/order/OrderNumberInput';
import QuantityRatioSlider from '../../../screens/order/QuantityRatioSlider';
import {
  EMPTY_TP_SL_LEG,
  TP_SL_KINDS,
  TP_SL_KIND_LABEL,
  TP_SL_RATIOS,
  type TpSlKind,
  type TpSlLegDraft,
} from '../tpSlModel';

const TEST_ID: Record<TpSlKind, string> = { take_profit: 'tp-sl-take-profit', stop_loss: 'tp-sl-stop-loss' };

/**
 * The 익절/손절 sections of the 손절가/익절가 sheet: each kind can be switched
 * on alone or together with the other, with its own trigger price and share
 * (slider + 25/50/75/100). The caller owns the drafts and says what a share
 * means (a holding's quantity, a position's reduction, a part of an entry's
 * fill) through `quantityText`; errors and hints are its own rules.
 */
export default function TpSlLegFields({
  legs,
  onPatch,
  disabled,
  ratioDisabled,
  currency,
  shareLabel,
  quantityText,
  error,
  warning,
  placeholder,
  onInputFocus,
  onInputBlur,
}: {
  legs: Record<TpSlKind, TpSlLegDraft>;
  onPatch: (kind: TpSlKind, patch: Partial<TpSlLegDraft>) => void;
  disabled: boolean;
  /** The basis is unknown: shares cannot be chosen yet. */
  ratioDisabled: boolean;
  /** Price currency label (KRW / USD). */
  currency: string;
  /** What the share is of, for the slider and chips (e.g. `보유 수량`). */
  shareLabel: string;
  quantityText: (kind: TpSlKind, leg: TpSlLegDraft) => string;
  error: (kind: TpSlKind) => string | null;
  warning?: (kind: TpSlKind) => string | null;
  placeholder: (kind: TpSlKind) => string;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  return (
    <View style={styles.sections}>
      {TP_SL_KINDS.map((kind) => {
        const leg = legs[kind];
        const id = TEST_ID[kind];
        const name = TP_SL_KIND_LABEL[kind];
        const problem = leg.enabled && (leg.triggerPrice.trim() || leg.percent > 0) ? error(kind) : null;
        const hint = leg.enabled && !problem ? warning?.(kind) ?? null : null;
        return (
          <View key={kind} style={styles.section} testID={`${id}-section`}>
            <ActionPressable
              testID={`${id}-toggle`}
              accessibilityRole="checkbox"
              accessibilityLabel={`${name}가 설정`}
              accessibilityState={{ checked: leg.enabled, disabled }}
              aria-checked={leg.enabled}
              disabled={disabled}
              onPress={() => onPatch(kind, leg.enabled ? { ...EMPTY_TP_SL_LEG } : { enabled: true })}
              style={[styles.toggle, leg.enabled && styles.toggleOn]}
            >
              <View style={[styles.toggleBox, leg.enabled && styles.toggleBoxOn]}>
                <Text style={styles.toggleMark}>{leg.enabled ? '✓' : ''}</Text>
              </View>
              <Text style={styles.toggleTitle}>{name}가 설정</Text>
            </ActionPressable>
            {leg.enabled ? (
              <View style={styles.fields}>
                <View style={styles.group}>
                  <Text style={styles.label}>{name}가 ({currency})</Text>
                  <OrderNumberInput
                    testID={`${id}-trigger-price`}
                    accessibilityLabel={`${name}가 ${currency}`}
                    editable={!disabled}
                    style={orderInputStyle}
                    value={leg.triggerPrice}
                    onChangeText={(value) => onPatch(kind, { triggerPrice: value })}
                    keyboardType="decimal-pad"
                    placeholder={placeholder(kind)}
                    onFieldFocus={onInputFocus}
                    onBlur={onInputBlur}
                  />
                </View>
                <View style={styles.group}>
                  <View style={styles.ratioLabel}>
                    <Text style={styles.label}>{name} 비율</Text>
                    <Text testID={`${id}-percent`} style={[styles.label, styles.ratioValue, { flexBasis: 36 * fontScale }]}>{leg.percent}%</Text>
                  </View>
                  <QuantityRatioSlider
                    testID={`${id}-slider`}
                    accessibilityLabel={`${name} 비율, ${shareLabel} 기준`}
                    value={leg.percent / 100}
                    disabled={disabled || ratioDisabled}
                    onChange={(ratio) => onPatch(kind, { percent: Math.max(0, Math.min(100, Math.round(ratio * 100))) })}
                  />
                  <View style={styles.ratios}>
                    {TP_SL_RATIOS.map((ratio) => (
                      <ActionPressable
                        key={ratio}
                        testID={`${id}-ratio-${ratio}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${name} 비율 ${shareLabel}의 ${ratio}%`}
                        accessibilityState={{ selected: leg.percent === ratio, disabled: disabled || ratioDisabled }}
                        aria-pressed={leg.percent === ratio}
                        disabled={disabled || ratioDisabled}
                        hitSlop={{ top: 6, bottom: 6 }}
                        onPress={() => onPatch(kind, { percent: ratio })}
                        style={[styles.ratioButton, { flexBasis: 34 * fontScale }, leg.percent === ratio && styles.ratioSelected]}
                      >
                        <Text style={[styles.ratioText, leg.percent === ratio && styles.ratioTextSelected]}>{ratio}%</Text>
                      </ActionPressable>
                    ))}
                  </View>
                  <Text testID={`${id}-quantity`} style={styles.quantity}>{quantityText(kind, leg)}</Text>
                  {hint ? <Text testID={`${id}-warning`} style={styles.warning}>{hint}</Text> : null}
                  {problem ? <Text testID={`${id}-error`} style={styles.error}>{problem}</Text> : null}
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  sections: { gap: 12, minWidth: 0 },
  section: { gap: 10, minWidth: 0 },
  fields: { gap: 10, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted, flexShrink: 1 },
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
    minHeight: 48,
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
  toggleTitle: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.text },
} as const;
