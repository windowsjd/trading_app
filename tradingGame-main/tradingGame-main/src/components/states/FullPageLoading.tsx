import React from 'react';
import { SafeAreaView, View, Text, ActivityIndicator, StyleSheet } from 'react-native';

interface FullPageLoadingProps {
  message?: string;
}

export default function FullPageLoading({
  message = '불러오는 중입니다.',
}: FullPageLoadingProps) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.message}>{message}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    marginTop: 12,
    fontSize: 14,
    color: '#444',
  },
});