import React from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { GuideStackParamList } from '../../app/navigation/types';
import { Body, GuideCard, LessonPage } from './LessonUi';
import { guideTopics, type GuideTopic } from './guideTopics';

export default function GuideTopicScreen({
  route,
  navigation,
}: NativeStackScreenProps<GuideStackParamList, GuideTopic>) {
  const topic = guideTopics[route.name];
  return (
    <LessonPage id={`guide-topic-${route.name}`}>
      <Body>{topic.description}</Body>
      {topic.chapters.map((chapter, i) => (
        <GuideCard
          key={chapter.id}
          testID={`guide-chapter-${chapter.id}`}
          number={`0${i + 1}`}
          title={chapter.title}
          description={chapter.description}
          accessibilityHint={`${chapter.title} 학습을 시작합니다.`}
          onPress={() =>
            navigation.navigate('GuideChapter', { chapter: chapter.id })
          }
        />
      ))}
    </LessonPage>
  );
}
