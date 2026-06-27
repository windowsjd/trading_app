import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function ChartEmptyState({
  message = '표시할 차트 데이터가 없습니다.',
}: {
  message?: string;
}) {
  return (
    <View style={styles.container} accessibilityRole="text">
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 128,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  text: {
    color: '#555',
    fontSize: 14,
    textAlign: 'center',
  },
});
