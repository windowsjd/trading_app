import { semantic } from '../../theme/tokens';
import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Platform } from '../../theme/native';
import { getScreenContentStyle } from '../../theme/screenLayout';

import type { GuideScreenProps } from '../../app/navigation/types';
import { GuideCard } from './LessonUi';
import { guideTopics, type GuideTopic } from './guideTopics';
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
  ...Object.entries(guideTopics).map(([route, topic]) => ({
    ...topic, route: route as GuideTopic, id: `guide-topic-card-${route}`,
  })),
] as const;

// The header already says 가이드: the list starts with the cards.
export default function GuideScreen({ navigation }: GuideScreenProps) {
  return (
    <SafeAreaView style={styles.container} testID={TEST_IDS.guide.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {availableGuides.map((guide) => (
          <GuideCard
            key={guide.route}
            testID={guide.id}
            number={guide.number}
            title={guide.title}
            description={guide.description}
            accessibilityHint={`${guide.title} 가이드를 엽니다.`}
            onPress={() => navigation.navigate(guide.route)}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, paddingBottom: 32, gap: 12 },
});
