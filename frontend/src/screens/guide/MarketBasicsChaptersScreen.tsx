import React from 'react';
import { Text } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { GuideStackParamList } from '../../app/navigation/types';
import ActionPressable from '../../components/common/ActionPressable';
import { Body, LessonPage, lessonStyles as s } from './LessonUi';

const chapters = [
  {
    route: 'OrderBookLesson',
    title: '호가창과 체결',
    description: '가격대별 대기 주문과 실제 체결을 통해 현재가가 형성되는 과정을 이해합니다.',
  },
  {
    route: 'Liquidity',
    title: '유동성과 가격 충격',
    description:
      '같은 주문도 시장의 대기 물량과 주문 규모에 따라 체결가격과 가격 영향이 달라지는 이유를 체험합니다.',
  },
] as const;
export default function MarketBasicsChaptersScreen({
  navigation,
}: NativeStackScreenProps<GuideStackParamList, 'MarketBasics'>) {
  return (
    <LessonPage id="guide-market-chapters">
      <Body>실제 주문과 체결 과정을 통해 시장 가격이 형성되는 구조를 학습합니다.</Body>
      {chapters.map((chapter, i) => (
        <ActionPressable
          key={chapter.route}
          testID={`guide-chapter-${chapter.route}`}
          accessibilityRole="button"
          accessibilityLabel={`${i + 1}. ${chapter.title}. ${chapter.description}`}
          onPress={() => navigation.navigate(chapter.route)}
          style={s.card}
        >
          <Text style={s.helper}>0{i + 1}</Text>
          <Text style={s.heading}>{chapter.title}</Text>
          <Text style={s.body}>{chapter.description}</Text>
          <Text style={[s.helper, s.bold]}>학습 시작 →</Text>
        </ActionPressable>
      ))}
    </LessonPage>
  );
}
