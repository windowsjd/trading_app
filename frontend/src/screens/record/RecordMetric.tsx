import React from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { getRecordFinancialDisplay } from '../../features/record/financialDisplay';

export default function RecordMetric({
  label, value, kind = 'money', signed = true, prominent = false, testID,
}: {
  label: string;
  value: string | null | undefined;
  kind?: 'money' | 'rate';
  signed?: boolean;
  prominent?: boolean;
  testID: string;
}) {
  const display = getRecordFinancialDisplay(value, kind, signed);
  return (
    <View style={styles.metric}>
      <Text style={styles.label}>{label}</Text>
      <Text testID={testID} style={[styles.value, prominent && styles.prominent, { color: display.color }]}>
        {display.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  metric: { minWidth: 0, gap: 4 },
  label: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  value: { fontSize: 22, lineHeight: 32, fontWeight: '700', flexShrink: 1, fontVariant: ['tabular-nums'] },
  prominent: { fontSize: 40, lineHeight: 52 },
});
