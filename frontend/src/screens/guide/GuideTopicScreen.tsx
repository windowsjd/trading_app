import React from 'react';
import { Text } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { GuideStackParamList } from '../../app/navigation/types';
import ActionPressable from '../../components/common/ActionPressable';
import { Body, LessonPage, lessonStyles as s } from './LessonUi';
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
        <ActionPressable
          key={chapter.id}
          testID={`guide-chapter-${chapter.id}`}
          style={s.card}
          accessibilityRole="button"
          accessibilityLabel={`${i + 1}. ${chapter.title}. ${chapter.description}`}
          onPress={() =>
            navigation.navigate('GuideChapter', { chapter: chapter.id })
          }
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
