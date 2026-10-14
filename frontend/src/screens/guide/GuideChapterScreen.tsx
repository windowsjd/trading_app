import React, { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { GuideStackParamList } from '../../app/navigation/types';
import { LessonAction, LessonPage, Section } from './LessonUi';
import { Basis } from './MarketLessonUi';
import { ClosedMarketLesson } from './StockLessons';
import {
  IndexLesson,
  EtfLesson,
  EtfPriceLesson,
  EtfPickLesson,
} from './EtfLessons';
import { chapterTitle, type GuideChapter } from './guideTopics';
import { VERIFIED_ON } from './marketLessonData';

const lessons = {
  'closed-market': ClosedMarketLesson,
  index: IndexLesson,
  etf: EtfLesson,
  'etf-price': EtfPriceLesson,
  'etf-pick': EtfPickLesson,
} satisfies Record<GuideChapter, React.ComponentType>;
const sources: Record<GuideChapter, string> = {
  'closed-market': 'KRX 거래시간·매매체결·시간외 거래, NYSE 거래시간',
  index: 'SEC 지수펀드·ETF',
  etf: 'SEC ETF, SEC 분산투자',
  'etf-price': 'SEC ETF',
  'etf-pick': 'SEC ETF·지수펀드·분산투자, Vanguard 지수 추종',
};
export default function GuideChapterScreen({
  route,
}: NativeStackScreenProps<GuideStackParamList, 'GuideChapter'>) {
  const [attempt, setAttempt] = useState(0);
  const chapter = route.params.chapter;
  const Lesson = lessons[chapter];
  // A new keyed page clears all local inputs/results and returns the scroll to its start.
  // Exercises advance on explicit actions: no playback timers or delayed measurements.
  return (
    <LessonPage key={`${chapter}-${attempt}`} id={`guide-lesson-${chapter}`}>
      <Section title={chapterTitle(chapter)} introduction>
        <Lesson />
      </Section>
      <Basis>
        자료 기준: {sources[chapter]} · 확인 {VERIFIED_ON}
      </Basis>
      <LessonAction
        id={`reset-${chapter}`}
        label="처음부터"
        secondary
        onPress={() => setAttempt((value) => value + 1)}
      />
    </LessonPage>
  );
}
