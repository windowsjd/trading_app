import React from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';

/**
 * A labelled checkbox row of the auth forms: the whole row is the 48pt touch
 * target and the label wraps (large fonts, 320pt screens).
 */
export default function AuthCheckbox({ testID, label, checked, disabled = false, onChange }: {
  testID: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <ActionPressable feedback="selection" testID={testID} accessibilityRole="checkbox" accessibilityLabel={label}
      accessibilityState={{ checked, disabled }} aria-checked={checked} disabled={disabled}
      onPress={() => onChange(!checked)} style={styles.row}>
      <View style={[styles.box, checked && styles.boxChecked]}>
        <Text style={styles.mark}>{checked ? '✓' : ''}</Text>
      </View>
      <Text style={styles.label}>{label}</Text>
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingVertical: 6 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' },
  boxChecked: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  mark: { color: semantic.onAccent, fontWeight: '700' },
  label: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', color: semantic.text },
});
