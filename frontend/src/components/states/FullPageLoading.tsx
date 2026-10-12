import { semantic } from '../../theme/tokens';
import React from 'react';
import { SafeAreaView, View, Text, StyleSheet } from '../../theme/native';
import WhaleLoader from './WhaleLoader';

interface FullPageLoadingProps {
  message?: string;
}

export default function FullPageLoading({
  message = '불러오는 중입니다.',
}: FullPageLoadingProps) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        <WhaleLoader size={56} testID="full-page-loading-indicator" />
        <Text style={styles.message}>{message}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    marginTop: 14,
    fontSize: 14,
    color: semantic.secondary,
  },
});