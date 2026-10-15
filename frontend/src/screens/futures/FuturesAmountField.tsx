import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import OrderNumberInput, { orderInputStyle } from '../order/OrderNumberInput';
import QuantityRatioSlider from '../order/QuantityRatioSlider';

const RATIOS = [0.25, 0.5, 0.75, 1] as const;

/**
 * The USD order amount (the position's notional, leverage applied) with what
 * it means in contracts, the 0–100% slider and quick ratios over the base the
 * screen gives (collateral capacity for entries, the position for a reduce),
 * and the 주문가능 line. The screen owns the amount, the ratio and their rules.
 */
export default function FuturesAmountField({ label, amount, onChange, editable, estimate, ratioLabel, ratio, activeRatio,
  ratioDisabled, ratioReason, onRatio, available, onInputFocus, onInputBlur }: {
  label: string;
  amount: string;
  onChange: (amount: string) => void;
  editable: boolean;
  /** Short lines under the input: 예상 수량, 증거금, 수수료. */
  estimate: string[];
  ratioLabel: string;
  ratio: number;
  /** The quick ratio the amount was written from, while it still matches. */
  activeRatio: number | null;
  ratioDisabled: boolean;
  ratioReason: string | null;
  onRatio: (ratio: number) => void;
  available: string;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  return (
    <View style={styles.stack} testID="futures-amount-field">
      <View style={styles.group}>
        <Text style={styles.label}>{label}</Text>
        <OrderNumberInput
          accessibilityLabel={label}
          testID="futures-amount"
          value={amount}
          onChangeText={onChange}
          editable={editable}
          keyboardType="decimal-pad"
          placeholder="USD 금액"
          style={styles.input}
          onFieldFocus={onInputFocus}
          onBlur={onInputBlur}
        />
      </View>
      {estimate.length ? (
        <View style={styles.estimate} testID="futures-amount-estimate">
          {estimate.map((line) => <Text key={line} style={styles.helper}>{line}</Text>)}
        </View>
      ) : null}
      <View style={styles.group}>
        <View style={styles.ratioLabel}>
          <Text style={styles.label}>{ratioLabel}</Text>
          {/* Room for 100% so digit changes cannot move the track during a drag. */}
          <Text testID="futures-amount-ratio" style={[styles.label, styles.ratioValue, { flexBasis: 36 * fontScale }]}>
            {Math.round(ratio * 100)}%
          </Text>
        </View>
        <QuantityRatioSlider
          testID="futures-amount-slider"
          accessibilityLabel={ratioLabel}
          value={ratio}
          disabled={!editable || ratioDisabled}
          disabledReason={ratioReason ?? undefined}
          onChange={onRatio}
        />
      </View>
      <View style={styles.ratios}>
        {RATIOS.map((value) => {
          const text = `${Math.round(value * 100)}%`;
          const selected = activeRatio === value;
          return (
            <ActionPressable
              key={value}
              testID={`futures-ratio-${Math.round(value * 100)}`}
              accessibilityRole="button"
              accessibilityLabel={`${ratioLabel} ${text}`}
              aria-pressed={selected}
              accessibilityState={{ disabled: !editable || ratioDisabled, selected }}
              disabled={!editable || ratioDisabled}
              hitSlop={{ top: 6, bottom: 6 }}
              onPress={() => onRatio(value)}
              style={[styles.ratioButton, { flexBasis: 34 * fontScale }, selected && styles.ratioSelected, (!editable || ratioDisabled) && styles.ratioPending]}
            >
              <Text style={[styles.ratioText, selected && styles.ratioTextSelected]}>{text}</Text>
            </ActionPressable>
          );
        })}
      </View>
      {ratioReason ? <Text style={styles.helper} testID="futures-ratio-reason" accessibilityLiveRegion="polite">{ratioReason}</Text> : null}
      <Text style={styles.helper} testID="futures-available-collateral">{available}</Text>
    </View>
  );
}

// The spot order form's ratio controls (OrderPanel), for one familiar look.
const styles = StyleSheet.create({
  stack: { gap: 12, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted },
  helper: { fontSize: 12, lineHeight: 18, color: semantic.secondary, flexShrink: 1 },
  input: { ...orderInputStyle },
  estimate: { gap: 2, minWidth: 0 },
  ratioLabel: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4, justifyContent: 'space-between' },
  ratioValue: { flexShrink: 1, fontVariant: ['tabular-nums'], textAlign: 'right' },
  ratios: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 3, rowGap: 12, paddingVertical: 6 },
  ratioButton: {
    backgroundColor: semantic.raised,
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
  },
  ratioText: { fontSize: 11, fontWeight: '600', color: semantic.text },
  ratioTextSelected: { color: semantic.onAccent },
  ratioSelected: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  ratioPending: { opacity: 0.4 },
});
