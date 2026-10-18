import { semantic } from '../../theme/tokens';
import React from 'react';
import { View, Text, StyleSheet } from '../../theme/native';

export default function InlineEmptyState({
  title = '데이터가 없습니다.',
  message,
  testID,
}: {
  title?: string;
  /** Omitted for a self-explanatory title (e.g. 보유 중인 종목이 없습니다.). */
  message?: string;
  testID?: string;
}) {
  return (
    <View style={styles.box} testID={testID}>
      <Text style={styles.title}>{title}</Text>
      {message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 14,
    backgroundColor: semantic.raised,
    gap: 6,
  },
  // Section notices carry full sentences; they wrap rather than clip.
  title: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
  message: { fontSize: 14, color: semantic.secondary, lineHeight: 20 },
});