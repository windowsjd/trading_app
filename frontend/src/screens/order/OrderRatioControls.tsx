import React from 'react';
import { Text, View, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import { RATIO_PICKS } from '../../features/conditional/conditionalRatio';
import QuantityRatioSlider from './QuantityRatioSlider';

/**
 * The ordinary order form's ratio controls — a label with the current share,
 * the shared QuantityRatioSlider and the 25/50/75/100% picks — for the
 * conditional BUY/SELL forms (2026-10-18). The form owns the size: a pick or
 * a drag asks it for the size at that ratio, and `value` follows the entered
 * size back (typing moves the thumb), so neither side ever writes the other.
 * While `disabled`, `reason` says why and the size can still be typed.
 */
export default function OrderRatioControls({
  testID,
  label,
  accessibilityLabel,
  pickLabel,
  value,
  active,
  disabled,
  reason,
  notice,
  tint,
  onChange,
}: {
  /** Prefix of `-slider`, `-percent`, `-25`…`-100`, `-reason`, `-notice`. */
  testID: string;
  label: string;
  /** The slider's spoken name (what the share is of). */
  accessibilityLabel: string;
  /** The picks' spoken name before the share (e.g. `보유 수량`). */
  pickLabel: string;
  /** The shown share, 0..1. */
  value: number;
  /** The pick that produced the current size, if any. */
  active: number | null;
  disabled: boolean;
  reason?: string | null;
  /** A pick that could not be applied (e.g. the size rounds to nothing). */
  notice?: string | null;
  /** The order side's color. */
  tint?: string;
  onChange: (ratio: number) => void;
}) {
  const { fontScale } = useWindowDimensions();
  return (
    <View style={styles.group} testID={testID}>
      <View style={styles.ratioLabel}>
        <Text style={styles.label}>{label}</Text>
        <Text testID={`${testID}-percent`} style={[styles.label, styles.ratioValue, { flexBasis: 36 * fontScale }]}>
          {Math.round(value * 100)}%
        </Text>
      </View>
      <QuantityRatioSlider
        testID={`${testID}-slider`}
        accessibilityLabel={accessibilityLabel}
        tint={tint}
        value={value}
        disabled={disabled}
        disabledReason={reason ?? undefined}
        onChange={onChange}
      />
      <View style={styles.ratios}>
        {RATIO_PICKS.map((ratio) => {
          const percent = Math.round(ratio * 100);
          const selected = active === ratio;
          return (
            <ActionPressable
              key={ratio}
              testID={`${testID}-${percent}`}
              accessibilityRole="button"
              accessibilityLabel={`${pickLabel} ${percent}%`}
              accessibilityState={{ selected, disabled }}
              aria-pressed={selected}
              aria-disabled={disabled}
              disabled={disabled}
              hitSlop={{ top: 6, bottom: 6 }}
              onPress={() => onChange(ratio)}
              style={[styles.ratioButton, { flexBasis: 34 * fontScale }, selected && styles.ratioSelected, disabled && styles.ratioDisabled]}
            >
              <Text style={[styles.ratioText, selected && styles.ratioTextSelected]}>{percent}%</Text>
            </ActionPressable>
          );
        })}
      </View>
      {reason ? <Text testID={`${testID}-reason`} style={styles.helper}>{reason}</Text> : null}
      {notice ? (
        <Text testID={`${testID}-notice`} accessibilityLiveRegion="polite" style={styles.warning}>{notice}</Text>
      ) : null}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks. Same metrics
// as the ordinary form's ratio row.
const styles = {
  group: { gap: 4, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted, flexShrink: 1 },
  helper: { fontSize: 12, lineHeight: 17, color: semantic.secondary },
  warning: { fontSize: 12, lineHeight: 17, color: semantic.warning },
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
  ratioDisabled: { opacity: 0.4 },
  ratioText: { fontSize: 11, fontWeight: '600', color: semantic.text },
  ratioTextSelected: { color: semantic.onAccent },
} as const;
