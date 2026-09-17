import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native';

import { TEST_IDS } from '../../constants/testIds';

export default function GuideScreen() {
  return (
    <SafeAreaView style={styles.container} testID={TEST_IDS.guide.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          가이드
        </Text>
        <Text style={styles.description}>
          투자 기초와 차트 활용 가이드를 준비하고 있습니다.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 32,
  },
  description: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 23,
    color: '#546e7a',
  },
});
