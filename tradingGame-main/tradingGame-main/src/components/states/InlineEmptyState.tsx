import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function InlineEmptyState({
  title = '데이터가 없습니다.',
  message,
}: {
  title?: string;
  message: string;
}) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    padding: 14,
    backgroundColor: '#fff',
    gap: 6,
  },
  title: { fontSize: 15, fontWeight: '700' },
  message: { fontSize: 14, color: '#444' },
});