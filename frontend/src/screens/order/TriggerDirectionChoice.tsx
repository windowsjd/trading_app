import React from 'react';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import type { TriggerCondition } from '../../features/conditional/autoDirection';

const LABEL: Record<TriggerCondition, string> = { at_or_above: '이상 도달', at_or_below: '이하 도달' };

/**
 * The 이상/이하 of a conditional order registered while its stock market is
 * closed (2026-10-18): two radio buttons with nothing preselected — an
 * off-session watch never assumes a direction, and the one chosen is sent
 * (and kept by the server) as is. During the session the direction follows
 * the current price instead and this choice is not shown.
 */
export default function TriggerDirectionChoice({
  testID,
  value,
  disabled,
  onChange,
}: {
  /** Prefix of `-at_or_above` / `-at_or_below`. */
  testID: string;
  value: TriggerCondition | null;
  disabled: boolean;
  onChange: (condition: TriggerCondition) => void;
}) {
  return (
    <View testID={testID} accessibilityRole="radiogroup" accessibilityLabel="감시 방향" style={styles.row}>
      {(['at_or_above', 'at_or_below'] as const).map((condition) => {
        const selected = value === condition;
        return (
          <ActionPressable
            key={condition}
            testID={`${testID}-${condition}`}
            accessibilityRole="radio"
            accessibilityLabel={`감시 방향 ${LABEL[condition]}`}
            accessibilityState={{ checked: selected, disabled }}
            aria-checked={selected}
            aria-disabled={disabled}
            disabled={disabled}
            onPress={() => onChange(condition)}
            style={[styles.option, selected && styles.selected, disabled && styles.disabled]}
          >
            <Text style={[styles.text, selected && styles.selectedText]}>{LABEL[condition]}</Text>
          </ActionPressable>
        );
      })}
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, minWidth: 0 },
  option: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 96,
    minHeight: 44,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selected: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  disabled: { opacity: 0.4 },
  text: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: semantic.text, textAlign: 'center' },
  selectedText: { color: semantic.onAccent },
} as const;
