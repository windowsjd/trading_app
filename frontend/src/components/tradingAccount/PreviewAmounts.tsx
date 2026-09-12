import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

/** Stack at narrow widths or larger font scales so full financial values wrap. */
export default function PreviewAmounts({
  rows,
}: {
  rows: Array<{ label: string; value: string }>;
}) {
  const { width, fontScale } = useWindowDimensions();
  const stacked = width / fontScale < 380;
  return (
    <View style={styles.list}>
      {rows.map(({ label, value }) => (
        <View key={label} style={[styles.row, stacked && styles.stacked]}>
          <Text style={styles.label}>{label}</Text>
          <Text style={[styles.value, stacked && styles.stackedValue]}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    flexWrap: 'wrap',
  },
  stacked: { flexDirection: 'column', gap: 3 },
  label: { fontSize: 14, color: '#555', lineHeight: 21, flexShrink: 1 },
  value: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
    lineHeight: 24,
    flexShrink: 1,
    minWidth: 0,
    flexGrow: 1,
    textAlign: 'right',
  },
  stackedValue: { textAlign: 'left', maxWidth: '100%' },
});
