import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { GuideScreenProps } from '../../app/navigation/types';
import ActionPressable from '../../components/common/ActionPressable';
import { TEST_IDS } from '../../constants/testIds';

const availableGuides = [
  {
    number: '01', title: '시장기초', route: 'MarketBasics', id: TEST_IDS.guide.marketBasicsCard,
    description: '호가·체결·유동성을 통해 시장 가격이 형성되고 움직이는 과정을 이해합니다.',
  },
  {
    number: '02', title: '캔들', route: 'Candles', id: 'guide-candles-card',
    description: '시가·고가·저가·종가와 시간 단위에 따라 가격 움직임이 캔들로 표현되는 방식을 이해합니다.',
  },
  {
    number: '03', title: '주문방식', route: 'OrderTypes', id: 'guide-order-types-card',
    description: '시장가와 지정가 주문이 실제 호가에서 어떻게 체결되는지 비교합니다.',
  },
] as const;
const upcomingGuides = [
  { number: '04', title: '주식특성', description: '주식의 기본적인 성격과 투자 시 고려할 특성을 살펴봅니다.' },
];

export default function GuideScreen({ navigation }: GuideScreenProps) {
  return (
    <SafeAreaView style={styles.container} testID={TEST_IDS.guide.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.introduction}>
          시장 구조와 투자에 필요한 핵심 개념을 직접 체험하며 학습합니다.
        </Text>
        <Text accessibilityRole="header" style={styles.sectionTitle}>기초 가이드</Text>

        {availableGuides.map((guide) => (
          <ActionPressable
            key={guide.route}
            testID={guide.id}
            style={styles.card}
            accessibilityRole="button"
            accessibilityLabel={`${guide.number} ${guide.title}. 이용 가능. ${guide.description}`}
            accessibilityHint={`${guide.title} 가이드를 엽니다.`}
            onPress={() => navigation.navigate(guide.route)}
          >
            <Text style={styles.number}>{guide.number}</Text>
            <Text style={styles.title}>{guide.title}</Text>
            <Text style={styles.description}>{guide.description}</Text>
            <Text style={styles.available}>이용 가능 · 학습 시작 →</Text>
          </ActionPressable>
        ))}

        {upcomingGuides.map((guide) => (
          <View key={guide.number} style={[styles.card, styles.upcoming]}>
            <Text style={styles.number}>{guide.number}</Text>
            <Text style={styles.title}>{guide.title}</Text>
            <Text style={styles.description}>{guide.description}</Text>
            <Text style={styles.unavailable}>준비 중</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  introduction: { fontSize: 16, lineHeight: 26, color: '#546e7a', marginBottom: 12 },
  sectionTitle: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: '#111' },
  card: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fff',
    gap: 8,
  },
  upcoming: { backgroundColor: '#fafafa', borderColor: '#eee' },
  number: { fontSize: 14, lineHeight: 22, fontWeight: '600', color: '#666' },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: '#111' },
  description: { fontSize: 16, lineHeight: 26, color: '#546e7a' },
  available: { fontSize: 14, lineHeight: 23, color: '#245b76', fontWeight: '700', marginTop: 4 },
  unavailable: { fontSize: 14, lineHeight: 23, color: '#666', marginTop: 4 },
});
